(() => {
  // ============================================================
  // 配置
  // ============================================================
  const CELL = 30;                  // 每格 30px
  const COLS = 30;                  // 30 列
  const ROWS = 20;                  // 20 行 → 900×600
  const STARTING_GOLD = 150;
  const STARTING_HP = 20;

  // 蛇形路径（格子坐标）。手工画一条好看的路径。
  const PATH = (() => {
    const pts = [];
    // 入口在左上 (0, 3)，蛇形走到右下出口
    // 第 1 段：横向往右 (0,3) → (8,3)
    for (let x = 0; x <= 8; x++) pts.push([x, 3]);
    // 第 2 段：向下 (8,3) → (8,9)
    for (let y = 4; y <= 9; y++) pts.push([8, y]);
    // 第 3 段：向左 (8,9) → (3,9)
    for (let x = 7; x >= 3; x--) pts.push([x, 9]);
    // 第 4 段：向下 (3,9) → (3,15)
    for (let y = 10; y <= 15; y++) pts.push([3, y]);
    // 第 5 段：向右 (3,15) → (20,15)
    for (let x = 4; x <= 20; x++) pts.push([x, 15]);
    // 第 6 段：向上 (20,15) → (20,7)
    for (let y = 14; y >= 7; y--) pts.push([20, y]);
    // 第 7 段：向右 (20,7) → (29,7)
    for (let x = 21; x <= 29; x++) pts.push([x, 7]);
    return pts;
  })();

  // 把路径格子塞到 Set 里方便 O(1) 查询
  const PATH_SET = new Set(PATH.map(([x, y]) => `${x},${y}`));

  // 像素中心坐标版本，给敌人插值用
  const PATH_PX = PATH.map(([x, y]) => [x * CELL + CELL / 2, y * CELL + CELL / 2]);

  // ============================================================
  // 塔配置
  // ============================================================
  const TOWERS = {
    basic:  { cost: 50,  range: 110, damage: 12, fireRate: 0.45, color: "#ffd24a", projectile: "#fff5b3", splash: 0,  proj_speed: 360 },
    sniper: { cost: 100, range: 220, damage: 45, fireRate: 1.1,  color: "#6bd6ff", projectile: "#b8e8ff", splash: 0,  proj_speed: 520 },
    splash: { cost: 120, range: 95,  damage: 18, fireRate: 0.85, color: "#c084ff", projectile: "#e4ccff", splash: 45, proj_speed: 300 },
  };

  // ============================================================
  // 波次配置：100 波，程序化生成
  // ============================================================
  // 设计：每波混编小怪+坦克，按节奏点出 Boss。难度通过 HP 倍率递增。
  function generateWaves() {
    const waves = [];
    for (let i = 1; i <= 100; i++) {
      const groups = [];
      // 小怪：基础 6 + 每波 +0.6，间隔随波次缩短
      const gruntCount = Math.floor(6 + i * 0.6);
      const gruntInterval = Math.max(0.18, 0.8 - i * 0.008);
      groups.push({ type: "grunt", count: gruntCount, interval: gruntInterval });
      // 坦克：第 3 波开始
      if (i >= 3) {
        const tankCount = Math.floor(1 + (i - 2) * 0.25);
        const tankInterval = Math.max(0.4, 1.5 - i * 0.012);
        groups.push({ type: "tank", count: tankCount, interval: tankInterval });
      }
      // Boss：每 5 波 1 个；25/50/75 波 2 个；100 波 5 个（最终 boss 战）
      if (i % 5 === 0) {
        let bossCount = 1;
        if (i === 100) bossCount = 5;
        else if (i === 25 || i === 50 || i === 75) bossCount = 2;
        groups.push({ type: "boss", count: bossCount, interval: 3.0 });
      }
      waves.push(groups);
    }
    return waves;
  }
  const WAVES = generateWaves();
  const TOTAL_WAVES = WAVES.length;

  // 难度倍率：HP 随波次递增，奖励同步增长
  function hpMultiplier(waveIdx) {
    return 1 + waveIdx * 0.04;       // 第 100 波 ≈ 4.96x
  }
  function rewardMultiplier(waveIdx) {
    return 1 + waveIdx * 0.006;      // 第 100 波 ≈ 1.6x
  }
  function waveEndBonus(waveIdx) {
    return 30 + Math.floor(waveIdx * 1.5);  // 第 1 波 31, 第 100 波 180
  }

  // ============================================================
  // 敌人配置
  // ============================================================
  const ENEMIES = {
    grunt: { hp: 30,   speed: 60,  reward: 5,  color: "#6dd478", size: 9,  name: "小怪" },
    tank:  { hp: 130,  speed: 40,  reward: 15, color: "#9aa4b8", size: 12, name: "坦克" },
    boss:  { hp: 800,  speed: 30,  reward: 80, color: "#ff5c5c", size: 16, name: "Boss" },
  };

  // ============================================================
  // 状态
  // ============================================================
  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  const state = {
    gold: STARTING_GOLD,
    hp: STARTING_HP,
    wave: 0,                  // 当前波次（已完成）
    kills: 0,
    towers: [],               // {x, y, type, cooldown}
    enemies: [],              // {x, y, hp, maxHp, type, pathIdx, speed}
    projectiles: [],          // {x, y, tx, ty, target, damage, color, splash, speed}
    particles: [],            // {x, y, vx, vy, life, color, size}
    selectedTower: null,      // 当前选中要放置的塔类型
    waveInProgress: false,
    spawnQueue: [],           // [{type, time}] 时间是相对波次开始的秒数
    waveStartTime: 0,
    gameOver: false,
    won: false,
    hoverCell: null,          // 鼠标悬停的格子
  };

  // ============================================================
  // HUD
  // ============================================================
  const hud = {
    wave:  document.getElementById("hudWave"),
    hp:    document.getElementById("hudHp"),
    gold:  document.getElementById("hudGold"),
    kills: document.getElementById("hudKills"),
  };
  function updateHud() {
    hud.wave.textContent  = `${Math.min(state.wave + (state.waveInProgress ? 1 : 0), TOTAL_WAVES)} / ${TOTAL_WAVES}`;
    hud.hp.textContent    = state.hp;
    hud.gold.textContent  = state.gold;
    hud.kills.textContent = state.kills;
  }

  // ============================================================
  // 输入：选塔、点击地图放塔、悬停高亮
  // ============================================================
  document.querySelectorAll(".tower-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.tower;
      if (state.selectedTower === t) {
        state.selectedTower = null;
      } else {
        state.selectedTower = t;
      }
      document.querySelectorAll(".tower-btn").forEach(b => {
        b.classList.toggle("active", b.dataset.tower === state.selectedTower);
      });
    });
  });

  function getCellFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    return [Math.floor(px / CELL), Math.floor(py / CELL)];
  }

  canvas.addEventListener("mousemove", (e) => {
    state.hoverCell = getCellFromEvent(e);
  });
  canvas.addEventListener("mouseleave", () => {
    state.hoverCell = null;
  });

  canvas.addEventListener("click", (e) => {
    if (!state.selectedTower) return;
    if (state.gameOver) return;
    const [cx, cy] = getCellFromEvent(e);
    if (cx < 0 || cy < 0 || cx >= COLS || cy >= ROWS) return;
    if (PATH_SET.has(`${cx},${cy}`)) return;
    if (state.towers.some(t => t.cx === cx && t.cy === cy)) return;
    const cfg = TOWERS[state.selectedTower];
    if (state.gold < cfg.cost) return;
    state.gold -= cfg.cost;
    state.towers.push({
      cx, cy,
      x: cx * CELL + CELL / 2,
      y: cy * CELL + CELL / 2,
      type: state.selectedTower,
      cooldown: 0,
    });
    updateHud();
  });

  // ============================================================
  // 开始波次
  // ============================================================
  const startBtn = document.getElementById("startWaveBtn");
  const resetBtn = document.getElementById("resetBtn");
  startBtn.addEventListener("click", () => {
    if (state.waveInProgress || state.gameOver) return;
    if (state.wave >= TOTAL_WAVES) return;
    const waveDef = WAVES[state.wave];
    state.spawnQueue = [];
    let t = 0;
    for (const group of waveDef) {
      for (let i = 0; i < group.count; i++) {
        state.spawnQueue.push({ type: group.type, time: t });
        t += group.interval;
      }
    }
    state.waveInProgress = true;
    state.waveStartTime = performance.now() / 1000;
    startBtn.disabled = true;
    startBtn.textContent = "波次进行中...";
  });

  resetBtn.addEventListener("click", () => {
    if (!confirm("确定要重新开始吗？")) return;
    resetGame();
  });

  function resetGame() {
    state.gold = STARTING_GOLD;
    state.hp = STARTING_HP;
    state.wave = 0;
    state.kills = 0;
    state.towers = [];
    state.enemies = [];
    state.projectiles = [];
    state.particles = [];
    state.selectedTower = null;
    state.waveInProgress = false;
    state.spawnQueue = [];
    state.gameOver = false;
    state.won = false;
    clearProgress();
    document.querySelectorAll(".tower-btn").forEach(b => b.classList.remove("active"));
    startBtn.disabled = false;
    startBtn.textContent = "开始波次";
    document.getElementById("overlay").classList.add("hidden");
    updateHud();
  }

  // ============================================================
  // 存档：只在波次"结束"那一刻存。战斗中途不存（避免序列化敌人/子弹）
  // ============================================================
  const SAVE_KEY = "charlie-pixel-defense-save";
  const SAVE_VERSION = 1;

  function saveProgress() {
    try {
      const data = {
        v: SAVE_VERSION,
        gold: state.gold,
        hp: state.hp,
        wave: state.wave,
        kills: state.kills,
        towers: state.towers.map(t => ({ cx: t.cx, cy: t.cy, type: t.type })),
      };
      localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    } catch (e) {
      // localStorage 满了或被禁用：静默失败，不影响游戏
    }
  }

  function loadProgress() {
    let data;
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      data = JSON.parse(raw);
    } catch (e) {
      return false;
    }
    if (!data || data.v !== SAVE_VERSION) return false;
    if (typeof data.wave !== "number" || data.wave < 0 || data.wave >= TOTAL_WAVES) return false;
    state.gold  = typeof data.gold === "number" ? data.gold : STARTING_GOLD;
    state.hp    = typeof data.hp === "number" ? data.hp : STARTING_HP;
    state.wave  = data.wave;
    state.kills = typeof data.kills === "number" ? data.kills : 0;
    state.towers = (data.towers || []).map(t => ({
      cx: t.cx,
      cy: t.cy,
      x: t.cx * CELL + CELL / 2,
      y: t.cy * CELL + CELL / 2,
      type: t.type,
      cooldown: 0,
    }));
    return true;
  }

  function clearProgress() {
    try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
  }

  document.getElementById("overlayRestart").addEventListener("click", resetGame);

  // ============================================================
  // 主循环
  // ============================================================
  let lastTime = performance.now();
  let frameId = null;
  function loop(now) {
    if (document.hidden) {
      frameId = null;
      return;
    }
    const dt = Math.min((now - lastTime) / 1000, 0.05);
    lastTime = now;
    if (!state.gameOver) {
      update(dt);
    }
    draw();
    frameId = requestAnimationFrame(loop);
  }

  function startLoop() {
    if (frameId === null) frameId = requestAnimationFrame(loop);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      lastTime = performance.now();
      startLoop();
    }
  });
  startLoop();

  // ============================================================
  // 更新逻辑
  // ============================================================
  function update(dt) {
    // 生成敌人
    if (state.waveInProgress) {
      const elapsed = performance.now() / 1000 - state.waveStartTime;
      while (state.spawnQueue.length && state.spawnQueue[0].time <= elapsed) {
        const spawn = state.spawnQueue.shift();
        const cfg = ENEMIES[spawn.type];
        const hpMul = hpMultiplier(state.wave);
        const scaledHp = Math.round(cfg.hp * hpMul);
        state.enemies.push({
          type: spawn.type,
          hp: scaledHp,
          maxHp: scaledHp,
          speed: cfg.speed,
          pathIdx: 0,
          progress: 0,           // 段内进度 0-1
          x: PATH_PX[0][0],
          y: PATH_PX[0][1],
        });
      }
    }

    // 移动敌人
    for (let i = state.enemies.length - 1; i >= 0; i--) {
      const e = state.enemies[i];
      const next = PATH_PX[e.pathIdx + 1];
      if (!next) {
        // 到达终点
        state.hp -= 1;
        state.enemies.splice(i, 1);
        updateHud();
        if (state.hp <= 0) endGame(false);
        continue;
      }
      const [cx, cy] = PATH_PX[e.pathIdx];
      const dx = next[0] - cx;
      const dy = next[1] - cy;
      const segLen = Math.hypot(dx, dy);
      e.progress += (e.speed * dt) / segLen;
      while (e.progress >= 1 && e.pathIdx < PATH_PX.length - 1) {
        e.pathIdx++;
        e.progress -= 1;
      }
      const [bx, by] = PATH_PX[e.pathIdx];
      const nxt = PATH_PX[e.pathIdx + 1];
      if (nxt) {
        e.x = bx + (nxt[0] - bx) * e.progress;
        e.y = by + (nxt[1] - by) * e.progress;
      } else {
        e.x = bx;
        e.y = by;
      }
    }

    // 塔射击
    for (const t of state.towers) {
      t.cooldown -= dt;
      if (t.cooldown > 0) continue;
      const cfg = TOWERS[t.type];
      // 找射程内最靠前（pathIdx 最大）的敌人
      let best = null, bestPos = -1;
      for (const e of state.enemies) {
        const d = Math.hypot(e.x - t.x, e.y - t.y);
        if (d > cfg.range) continue;
        const pos = e.pathIdx + e.progress;
        if (pos > bestPos) {
          best = e;
          bestPos = pos;
        }
      }
      if (!best) continue;
      // 发射
      state.projectiles.push({
        x: t.x, y: t.y,
        target: best,
        damage: cfg.damage,
        color: cfg.projectile,
        splash: cfg.splash,
        speed: cfg.proj_speed,
      });
      t.cooldown = cfg.fireRate;
    }

    // 移动子弹
    for (let i = state.projectiles.length - 1; i >= 0; i--) {
      const p = state.projectiles[i];
      // 目标如果死了，朝它最后位置飞
      const tx = p.target.x;
      const ty = p.target.y;
      const dx = tx - p.x;
      const dy = ty - p.y;
      const d = Math.hypot(dx, dy);
      const step = p.speed * dt;
      if (d <= step) {
        // 命中
        if (p.splash > 0) {
          // AOE
          for (const e of state.enemies) {
            const dd = Math.hypot(e.x - tx, e.y - ty);
            if (dd <= p.splash) {
              dealDamage(e, p.damage);
            }
          }
          spawnSplashParticles(tx, ty, p.color);
        } else {
          if (state.enemies.includes(p.target)) {
            dealDamage(p.target, p.damage);
          }
          spawnHitParticles(tx, ty, p.color);
        }
        state.projectiles.splice(i, 1);
      } else {
        p.x += (dx / d) * step;
        p.y += (dy / d) * step;
      }
    }

    // 移除死亡敌人
    for (let i = state.enemies.length - 1; i >= 0; i--) {
      const e = state.enemies[i];
      if (e.hp <= 0) {
        state.gold += Math.round(ENEMIES[e.type].reward * rewardMultiplier(state.wave));
        state.kills += 1;
        spawnDeathParticles(e.x, e.y, ENEMIES[e.type].color);
        state.enemies.splice(i, 1);
        updateHud();
      }
    }

    // 粒子
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vy += 120 * dt;          // 重力
      p.life -= dt;
      if (p.life <= 0) state.particles.splice(i, 1);
    }

    // 检查波次结束
    if (state.waveInProgress && state.spawnQueue.length === 0 && state.enemies.length === 0) {
      state.waveInProgress = false;
      state.wave += 1;
      state.gold += waveEndBonus(state.wave);
      startBtn.disabled = false;
      startBtn.textContent = state.wave >= TOTAL_WAVES ? "已通关" : "开始下一波";
      saveProgress();
      updateHud();
      if (state.wave >= TOTAL_WAVES) endGame(true);
    }
  }

  function dealDamage(enemy, dmg) {
    enemy.hp -= dmg;
  }

  function spawnHitParticles(x, y, color) {
    for (let i = 0; i < 4; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 120,
        vy: (Math.random() - 0.5) * 120,
        life: 0.35,
        color,
        size: 2 + Math.random() * 2,
      });
    }
  }
  function spawnSplashParticles(x, y, color) {
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 60 + Math.random() * 120;
      state.particles.push({
        x, y,
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s,
        life: 0.5 + Math.random() * 0.3,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }
  function spawnDeathParticles(x, y, color) {
    for (let i = 0; i < 10; i++) {
      state.particles.push({
        x, y,
        vx: (Math.random() - 0.5) * 200,
        vy: (Math.random() - 0.5) * 200 - 60,
        life: 0.6 + Math.random() * 0.3,
        color,
        size: 2 + Math.random() * 3,
      });
    }
  }

  function endGame(won) {
    state.gameOver = true;
    state.won = won;
    clearProgress();
    const overlay = document.getElementById("overlay");
    const card = document.getElementById("overlayCard");
    const title = document.getElementById("overlayTitle");
    const msg = document.getElementById("overlayMsg");
    const stats = document.getElementById("overlayStats");
    card.classList.toggle("lose", !won);
    title.textContent = won ? "🎉 通关！" : "💔 防线告破";
    msg.textContent = won ? "你成功守住了基地！" : "基地被攻破了，再来一次？";
    stats.innerHTML = `波次 ${state.wave} / ${TOTAL_WAVES}<br>击杀 ${state.kills}<br>剩余生命 ${Math.max(state.hp, 0)}`;
    overlay.classList.remove("hidden");
  }

  // ============================================================
  // 渲染
  // ============================================================
  function draw() {
    // 背景
    ctx.fillStyle = "#18243d";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 网格
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * CELL + 0.5, 0);
      ctx.lineTo(x * CELL + 0.5, ROWS * CELL);
      ctx.stroke();
    }
    for (let y = 0; y <= ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * CELL + 0.5);
      ctx.lineTo(COLS * CELL, y * CELL + 0.5);
      ctx.stroke();
    }

    // 路径（先画底色，再画装饰条纹做"地砖"感）
    for (const [x, y] of PATH) {
      ctx.fillStyle = "#3d4f78";
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      ctx.fillStyle = "#4a5d8a";
      ctx.fillRect(x * CELL + 4, y * CELL + 4, CELL - 8, CELL - 8);
    }
    // 入口/出口标记
    const [sx, sy] = PATH[0];
    const [ex, ey] = PATH[PATH.length - 1];
    ctx.fillStyle = "#6bd6ff";
    ctx.fillRect(sx * CELL + 6, sy * CELL + 6, CELL - 12, CELL - 12);
    ctx.fillStyle = "#ff6b7a";
    ctx.fillRect(ex * CELL + 6, ey * CELL + 6, CELL - 12, CELL - 12);

    // 悬停高亮
    if (state.hoverCell && state.selectedTower && !state.gameOver) {
      const [hx, hy] = state.hoverCell;
      if (hx >= 0 && hy >= 0 && hx < COLS && hy < ROWS) {
        const onPath = PATH_SET.has(`${hx},${hy}`);
        const occupied = state.towers.some(t => t.cx === hx && t.cy === hy);
        const cfg = TOWERS[state.selectedTower];
        const canPlace = !onPath && !occupied && state.gold >= cfg.cost;
        ctx.fillStyle = canPlace ? "rgba(46, 204, 113, 0.25)" : "rgba(231, 76, 60, 0.25)";
        ctx.fillRect(hx * CELL, hy * CELL, CELL, CELL);
        // 射程预览
        if (canPlace) {
          ctx.strokeStyle = "rgba(255, 210, 74, 0.4)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(hx * CELL + CELL / 2, hy * CELL + CELL / 2, cfg.range, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
    }

    // 塔
    for (const t of state.towers) {
      const cfg = TOWERS[t.type];
      // 基座
      ctx.fillStyle = "#2a3a60";
      ctx.fillRect(t.cx * CELL + 4, t.cy * CELL + 4, CELL - 8, CELL - 8);
      // 主体
      ctx.fillStyle = cfg.color;
      ctx.fillRect(t.cx * CELL + 7, t.cy * CELL + 7, CELL - 14, CELL - 14);
      // 顶部装饰
      ctx.fillStyle = "#fff";
      ctx.fillRect(t.cx * CELL + CELL / 2 - 2, t.cy * CELL + CELL / 2 - 2, 4, 4);
    }

    // 敌人
    for (const e of state.enemies) {
      const cfg = ENEMIES[e.type];
      // 像素身体（方形）
      ctx.fillStyle = cfg.color;
      ctx.fillRect(e.x - cfg.size, e.y - cfg.size, cfg.size * 2, cfg.size * 2);
      // 边框（暗）
      ctx.fillStyle = "rgba(0,0,0,0.3)";
      ctx.fillRect(e.x - cfg.size, e.y - cfg.size, cfg.size * 2, 2);
      ctx.fillRect(e.x - cfg.size, e.y + cfg.size - 2, cfg.size * 2, 2);
      // 眼睛
      ctx.fillStyle = "#fff";
      ctx.fillRect(e.x - cfg.size / 2 - 1, e.y - 2, 3, 3);
      ctx.fillRect(e.x + cfg.size / 2 - 2, e.y - 2, 3, 3);
      // 血条
      const w = cfg.size * 2;
      const hpPct = Math.max(0, e.hp / e.maxHp);
      ctx.fillStyle = "#000";
      ctx.fillRect(e.x - cfg.size, e.y - cfg.size - 6, w, 3);
      ctx.fillStyle = hpPct > 0.5 ? "#6dd478" : hpPct > 0.25 ? "#ffd24a" : "#ff6b7a";
      ctx.fillRect(e.x - cfg.size, e.y - cfg.size - 6, w * hpPct, 3);
    }

    // 子弹
    for (const p of state.projectiles) {
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
    }

    // 粒子
    for (const p of state.particles) {
      ctx.globalAlpha = Math.min(1, p.life * 2);
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  // 启动：尝试恢复存档
  if (loadProgress() && state.wave > 0) {
    startBtn.textContent = state.wave >= TOTAL_WAVES ? "已通关" : "开始下一波";
  }
  updateHud();
})();
