// ============================================================
//  © 2026 EzDev Studio (Ezz Aldeen Al-Shaikh) — All rights reserved. See LICENSE.
//  القبة الحديدية — Iron Dome
//  محرك Phaser 3 (أقوى مكتبة ألعاب متصفح ثنائية الأبعاد على GitHub)
//  أنت في مقر المراقبة والتحكم:
//  - اضغط صاروخاً قادماً لاعتراضه بصواريخ القبة
//  - اضغط منصة إطلاق معادية لضربها بصاروخ مضاد (تجهيز ٧ ثوانٍ)
// ============================================================

const W = 720, H = 960;
const CITY_Y = 905;          // خط المدينة في الأسفل
const STRIKE_COOLDOWN = 7000; // مللي ثانية

// مؤثرات صوتية مولّدة بـ WebAudio (بلا ملفات خارجية)
const SFX = {
  ctx: null, muted: false,
  ensure() {
    if (!this.ctx) { try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, type, vol, slideTo) {
    if (this.muted || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type || 'square';
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    g.gain.setValueAtTime(vol || 0.08, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(this.ctx.destination);
    o.start(t); o.stop(t + dur);
  },
  launch() { this.tone(520, 0.18, 'square', 0.045, 980); },
  strikeLaunch() { this.tone(170, 0.45, 'sawtooth', 0.07, 720); },
  boom(big) { this.tone(big ? 90 : 140, big ? 0.5 : 0.3, 'sawtooth', 0.11, 40); },
  cityHit() { this.tone(70, 0.6, 'sawtooth', 0.15, 30); },
  shieldUp() { this.tone(660, 0.28, 'sine', 0.09, 990); }
};
window.toggleMute = function (btn) {
  SFX.muted = !SFX.muted;
  btn.textContent = SFX.muted ? '🔇 الصوت: مغلق' : '🔊 الصوت: يعمل';
};

class IronDomeScene extends Phaser.Scene {
  constructor() { super('IronDome'); }

  create() {
    this.score = 0;
    this.wave = 0;
    this.cityHP = 100;
    this.intercepted = 0;
    this.gameOver = false;
    this.pausedGame = false;
    this.lastShotAt = 0;
    this.strikeReadyAt = 0;
    this.spawnedThisWave = 0;
    this.rocketsToSpawn = 0;
    this.lastSpawnAt = 0;
    this.spawnInterval = 1300;
    this.betweenWaves = false;
    this.streak = 0;
    this.shield = false;
    this.blastRadius = 58;
    this.interceptorSpeed = 720;
    this.best = 0;
    try { this.best = parseInt(localStorage.getItem('ironDomeBest') || '0', 10) || 0; } catch (e) {}

    this.makeTextures();
    this.drawBackground();

    this.rockets = this.add.group();
    this.interceptors = this.add.group();
    this.strikes = this.add.group();
    this.launchers = [];
    this.batteries = [];

    // منصات إطلاق العدو (الأعلى)
    const lx = [90, 270, 450, 630];
    lx.forEach((x) => {
      const pad = this.add.image(x, 105, 'launcher').setDepth(3);
      this.launchers.push({ sprite: pad, x: x, y: 105, alive: true, respawnAt: 0 });
    });

    // بطاريات القبة الحديدية (الأسفل)
    const bx = [120, 360, 600];
    bx.forEach((x) => {
      const b = this.add.image(x, 815, 'battery').setDepth(3);
      this.batteries.push({ sprite: b, x: x, y: 790 });
    });

    // رادار دوّار — مقر المراقبة
    this.radar = this.add.image(360, 300, 'radar').setDepth(2).setAlpha(0.9);
    this.tweens.add({ targets: this.radar, angle: 360, duration: 5000, repeat: -1, ease: 'Linear' });

    // قبة الدرع (تظهر عند تفعيل درع الطاقة)
    this.shieldDome = this.add.graphics().setDepth(5).setAlpha(0);
    this.shieldDome.lineStyle(4, 0x4dd0e1, 0.9);
    this.shieldDome.beginPath();
    this.shieldDome.arc(360, CITY_Y + 10, 330, Math.PI, 0, false);
    this.shieldDome.strokePath();

    // نص الموجة
    this.banner = this.add.text(360, 430, '', {
      fontFamily: 'Tahoma, Arial', fontSize: '52px', fontStyle: 'bold',
      color: '#ffd54a', stroke: '#000000', strokeThickness: 6
    }).setOrigin(0.5).setDepth(20).setAlpha(0);

    this.hudTimer = 0;

    this.input.on('pointerdown', (p) => this.onTap(p));

    this.input.keyboard.on('keydown-SPACE', () => {
      // اعتراض تلقائي لأخطر صاروخ (الأقرب إلى المدينة)
      let target = null, best = -1;
      this.rockets.getChildren().forEach((r) => { if (r.active && r.y > best) { best = r.y; target = r; } });
      if (target) this.launchInterceptor(target.x, target.y, target);
    });

    // واجهة مقر التحكم (HTML)
    const scene = this;
    window.gameControl = {
      togglePause: function (btn) {
        if (scene.gameOver) return;
        scene.pausedGame = !scene.pausedGame;
        if (scene.pausedGame) { scene.scene.pause(); btn.textContent = '▶️ استئناف'; }
        else { scene.scene.resume(); btn.textContent = '⏸️ إيقاف مؤقت'; }
      },
      restart: function () { scene.scene.restart(); }
    };

    this.pushHQ();
    this.startWave(1);
  }

  // ---------- رسومات مولّدة برمجياً (بلا ملفات خارجية) ----------
  makeTextures() {
    let g = this.make.graphics({ x: 0, y: 0 }, false);

    // صاروخ العدو: جسم رمادي + رأس أحمر + لهب
    g.clear();
    g.fillStyle(0xd8dde6, 1); g.fillRect(10, 12, 12, 26);
    g.fillStyle(0xe53935, 1); g.fillTriangle(16, 0, 8, 14, 24, 14);
    g.fillStyle(0x9e9e9e, 1); g.fillTriangle(10, 34, 2, 46, 10, 46); g.fillTriangle(22, 34, 30, 46, 22, 46);
    g.fillStyle(0xff9800, 1); g.fillTriangle(16, 52, 11, 38, 21, 38);
    g.generateTexture('rocket', 32, 54); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // صاروخ السرب السريع: صغير برتقالي
    g.fillStyle(0xffccbc, 1); g.fillRect(6, 9, 9, 18);
    g.fillStyle(0xff5722, 1); g.fillTriangle(10, 0, 4, 11, 17, 11);
    g.fillStyle(0xff9800, 1); g.fillTriangle(10, 36, 6, 26, 15, 26);
    g.generateTexture('rocket_fast', 21, 38); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // الصاروخ المدرّع: أكبر وأغمق
    g.fillStyle(0x8d9bb5, 1); g.fillRect(9, 12, 16, 32);
    g.fillStyle(0xb71c1c, 1); g.fillTriangle(17, 0, 6, 15, 28, 15);
    g.fillStyle(0x607d8b, 1); g.fillRect(6, 20, 22, 5);
    g.fillStyle(0xff9800, 1); g.fillTriangle(17, 58, 10, 42, 24, 42);
    g.generateTexture('rocket_armored', 34, 60); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // صاروخ اعتراضي: أبيض + رأس أزرق
    g.fillStyle(0xffffff, 1); g.fillRect(6, 10, 9, 22);
    g.fillStyle(0x29b6f6, 1); g.fillTriangle(10, 0, 4, 12, 17, 12);
    g.fillStyle(0x90caf9, 1); g.fillTriangle(6, 28, 0, 38, 6, 38); g.fillTriangle(15, 28, 21, 38, 15, 38);
    g.fillStyle(0xffd54a, 1); g.fillTriangle(10, 42, 6, 31, 15, 31);
    g.generateTexture('interceptor', 21, 44); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // صاروخ الضربة المضادة: كبير كاكي
    g.fillStyle(0x7a8b3d, 1); g.fillRect(9, 14, 16, 36);
    g.fillStyle(0x37474f, 1); g.fillTriangle(17, 0, 7, 16, 27, 16);
    g.fillStyle(0x546e7a, 1); g.fillTriangle(9, 44, 0, 60, 9, 60); g.fillTriangle(25, 44, 34, 60, 25, 60);
    g.fillStyle(0xff7043, 1); g.fillTriangle(17, 68, 10, 50, 24, 50);
    g.generateTexture('strike', 34, 70); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // منصة إطلاق العدو
    g.fillStyle(0x455a64, 1); g.fillRect(4, 40, 76, 14);
    g.fillStyle(0x263238, 1); g.fillRect(14, 52, 14, 10); g.fillRect(56, 52, 14, 10);
    g.fillStyle(0x78909c, 1);
    g.save(); g.translateCanvas(42, 42); g.rotateCanvas(-0.6); g.fillRect(-7, -38, 14, 38); g.restore();
    g.fillStyle(0xe53935, 1); g.fillCircle(42, 12, 5);
    g.generateTexture('launcher', 84, 64); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // منصة مدمّرة
    g.fillStyle(0x212121, 1); g.fillRect(4, 44, 76, 10);
    g.fillStyle(0x111111, 1); g.fillTriangle(20, 44, 42, 18, 62, 44);
    g.fillStyle(0x616161, 1); g.fillCircle(30, 30, 7); g.fillCircle(52, 24, 9);
    g.generateTexture('launcher_dead', 84, 64); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // بطارية القبة الحديدية
    g.fillStyle(0x37474f, 1); g.fillRect(4, 48, 84, 14);
    g.fillStyle(0x546e7a, 1); g.fillRect(34, 26, 24, 24);
    g.fillStyle(0x29b6f6, 1);
    [-14, 0, 14].forEach((dx) => { g.fillRect(42 + dx - 3, 2, 6, 26); });
    g.fillStyle(0x81d4fa, 1); g.fillCircle(46, 34, 6);
    g.generateTexture('battery', 92, 64); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // مبنى مدينة
    g.fillStyle(0x1b2a44, 1); g.fillRect(0, 0, 56, 110);
    g.fillStyle(0xffd54a, 1);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++)
      if ((r * 3 + c) % 3 !== 0) g.fillRect(8 + c * 17, 10 + r * 20, 9, 11);
    g.generateTexture('building', 56, 110); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    // رادار
    g.lineStyle(2, 0x29b6f6, 0.8); g.strokeCircle(30, 30, 28); g.strokeCircle(30, 30, 17);
    g.fillStyle(0x29b6f6, 0.35); g.fillTriangle(30, 30, 30, 2, 52, 16);
    g.fillStyle(0x6ee7ff, 1); g.fillCircle(30, 30, 4);
    g.generateTexture('radar', 60, 60); g.destroy();

    g = this.make.graphics({ x: 0, y: 0 }, false);
    g.fillStyle(0xffffff, 1); g.fillCircle(4, 4, 4);
    g.generateTexture('dot', 8, 8); g.destroy();
  }

  drawBackground() {
    // سماء ليلية متدرجة + نجوم
    const bg = this.add.graphics().setDepth(0);
    bg.fillGradientStyle(0x0a1830, 0x0a1830, 0x274b73, 0x274b73, 1);
    bg.fillRect(0, 0, W, H);
    for (let i = 0; i < 70; i++) {
      this.add.image(Phaser.Math.Between(5, W - 5), Phaser.Math.Between(180, 700), 'dot')
        .setAlpha(Phaser.Math.FloatBetween(0.15, 0.6)).setScale(Phaser.Math.FloatBetween(0.3, 0.8)).setDepth(0);
    }
    // منطقة العدو (أعلى) بلمسة حمراء
    const ez = this.add.graphics().setDepth(1);
    ez.fillStyle(0x8e2424, 0.16); ez.fillRect(0, 0, W, 165);
    ez.lineStyle(2, 0xe53935, 0.55); ez.lineBetween(0, 165, W, 165);
    this.add.text(360, 18, 'منطقة العدو — منصات الإطلاق', {
      fontFamily: 'Tahoma, Arial', fontSize: '19px', color: '#ff9d97'
    }).setOrigin(0.5, 0).setDepth(2);

    // خط المدينة + أرض
    const gr = this.add.graphics().setDepth(1);
    gr.fillStyle(0x10203a, 1); gr.fillRect(0, CITY_Y, W, H - CITY_Y);
    gr.lineStyle(2, 0x37d67a, 0.6); gr.lineBetween(0, CITY_Y, W, CITY_Y);
    for (let x = 28; x < W; x += 62) {
      this.add.image(x, CITY_Y + 52, 'building').setDepth(1).setAlpha(0.95);
    }
    this.add.text(360, CITY_Y + 2, '', { fontSize: '1px' }).setDepth(1);
  }

  // ---------- منطق اللعب ----------
  startWave(n) {
    this.wave = n;
    this.spawnedThisWave = 0;
    this.rocketsToSpawn = 6 + n * 4;
    this.spawnInterval = Math.max(520, 1350 - n * 110);
    this.lastSpawnAt = 0;
    this.betweenWaves = false;
    // إحياء منصات مدمّرة مع موجة جديدة (عدا الأولى)
    this.launchers.forEach((L) => {
      if (!L.alive && n > 1) { L.alive = true; L.sprite.setTexture('launcher'); L.sprite.clearTint(); }
    });
    this.blastRadius = Math.min(88, 58 + Math.floor((n - 1) / 2) * 6);
    this.interceptorSpeed = Math.min(920, 720 + (n - 1) * 16);
    this.banner.setText('الموجة ' + n);
    this.banner.setAlpha(1);
    this.tweens.add({ targets: this.banner, alpha: 0, duration: 900, delay: 900 });
    this.pushHQ();
  }

  spawnRocket(now) {
    const alive = this.launchers.filter((L) => L.alive);
    if (!alive.length) return;
    const L = Phaser.Utils.Array.GetRandom(alive);
    const roll = Math.random();
    const kind = (this.wave >= 3 && roll < 0.22) ? 'fast'
               : (this.wave >= 2 && roll < 0.40) ? 'armored' : 'normal';
    const tex = kind === 'fast' ? 'rocket_fast' : kind === 'armored' ? 'rocket_armored' : 'rocket';
    const r = this.add.image(L.x, L.y + 26, tex).setDepth(6);
    const tx = Phaser.Math.Between(40, W - 40);
    const dx = tx - r.x, dy = CITY_Y - r.y;
    const len = Math.hypot(dx, dy) || 1;
    const base = kind === 'fast' ? 235 : kind === 'armored' ? 105 : 145;
    const speed = base + this.wave * 11 + Phaser.Math.Between(0, 35);
    r.setData({
      vx: (dx / len) * speed, vy: (dy / len) * speed,
      tx: tx, trailAt: 0, kind: kind,
      hp: kind === 'armored' ? 2 : 1,
      armored: kind === 'armored',
      dmg: kind === 'fast' ? 5 : kind === 'armored' ? 16 : 10,
      scoreVal: kind === 'fast' ? 15 : kind === 'armored' ? 40 : 20
    });
    r.rotation = Math.atan2(dy, dx) + Math.PI / 2;
    this.rockets.add(r);
    this.spawnedThisWave++;
    this.lastSpawnAt = now;
    // وميض إطلاق عند المنصة
    this.flash(L.x, L.y + 30, 0xffa726, 16);
  }

  nearestBattery(x, y) {
    let best = this.batteries[0], bd = 1e9;
    this.batteries.forEach((b) => { const d = (b.x - x) ** 2 + (b.y - y) ** 2; if (d < bd) { bd = d; best = b; } });
    return best;
  }

  onTap(p) {
    SFX.ensure();
    if (this.gameOver) { this.scene.restart(); return; }
    const wx = p.worldX, wy = p.worldY;

    // ١) ضربة مضادة: الضغط قرب منصة حية
    for (const L of this.launchers) {
      if (L.alive && Phaser.Math.Distance.Between(wx, wy, L.x, L.y) < 78) {
        this.launchStrike(L);
        return;
      }
    }
    // ٢) اعتراض: أقرب صاروخ لنقطة الضغط (ضمن مدى الالتقاط) أو نقطة الضغط نفسها
    let target = null, bd = 120 * 120;
    this.rockets.getChildren().forEach((r) => {
      if (!r.active) return;
      const d = (r.x - wx) ** 2 + (r.y - wy) ** 2;
      if (d < bd) { bd = d; target = r; }
    });
    this.launchInterceptor(wx, wy, target);
  }

  launchInterceptor(tx, ty, targetRocket) {
    const now = this.time.now;
    if (now - this.lastShotAt < 170) return;
    this.lastShotAt = now;
    const b = this.nearestBattery(tx, ty);
    const s = this.add.image(b.x, b.y - 20, 'interceptor').setDepth(7);
    s.setData({ target: targetRocket || null, tx: tx, ty: ty, speed: this.interceptorSpeed, born: now });
    SFX.launch();
    this.interceptors.add(s);
    this.flash(b.x, b.y - 26, 0x6ee7ff, 10);
  }

  launchStrike(L) {
    const now = this.time.now;
    if (now < this.strikeReadyAt) {
      // غير جاهزة: تنبيه بصري
      this.flash(L.x, L.y, 0xe53935, 22);
      return;
    }
    this.strikeReadyAt = now + STRIKE_COOLDOWN;
    // تنطلق من مقر القيادة في المنتصف الأسفل
    const s = this.add.image(360, 800, 'strike').setDepth(7).setScale(1.05);
    s.setData({ target: L, tx: L.x, ty: L.y, speed: 560 });
    this.strikes.add(s);
    SFX.strikeLaunch();
    this.pushHQ();
  }

  flash(x, y, color, radius) {
    const c = this.add.circle(x, y, radius, color, 0.75).setDepth(15);
    this.tweens.add({ targets: c, scale: 2.1, alpha: 0, duration: 260, onComplete: () => c.destroy() });
  }

  explode(x, y, radius, damage) {
    if (damage > 0 || radius > 60) SFX.boom(radius > 60);
    // جسيمات انفجار حقيقية (Phaser Particles)
    try {
      const p = this.add.particles(x, y, 'dot', {
        speed: { min: 60, max: 280 }, lifespan: 480, quantity: 16,
        scale: { start: 1.5, end: 0 }, tint: [0xffb300, 0xff7043, 0xffffff], emitting: false
      }).setDepth(18);
      p.explode(16, x, y);
      this.time.delayedCall(650, () => p.destroy());
    } catch (e) {}
    const c = this.add.circle(x, y, radius, 0xffb300, 0.5).setDepth(16);
    const core = this.add.circle(x, y, radius * 0.45, 0xffffff, 0.9).setDepth(17);
    this.tweens.add({
      targets: [c, core], scale: 1.5, alpha: 0, duration: 300,
      onComplete: () => { c.destroy(); core.destroy(); }
    });
    // إصابة الصواريخ داخل نطاق الانفجار
    const victims = [];
    this.rockets.getChildren().forEach((r) => {
      if (r.active && Phaser.Math.Distance.Between(x, y, r.x, r.y) <= radius + 14) victims.push(r);
    });
    victims.forEach((r) => {
      const hp = r.getData('hp') - damage;
      if (hp <= 0) {
        this.score += r.getData('scoreVal') || 20;
        this.intercepted++;
        this.streak++;
        if (this.streak >= 10 && !this.shield) {
          this.shield = true; this.streak = 0;
          this.shieldDome.setAlpha(0.85);
          SFX.shieldUp();
          this.banner.setText('🛡️ درع الطاقة مفعّل!');
          this.banner.setAlpha(1);
          this.tweens.add({ targets: this.banner, alpha: 0, duration: 800, delay: 800 });
        }
        r.destroy();
      } else {
        r.setData('hp', hp); r.setTint(0xffccbc);
      }
    });
    if (victims.length) this.pushHQ();
  }

  cityHit(r) {
    if (this.shield) {
      this.shield = false;
      this.shieldDome.setAlpha(0);
      this.explode(r.x, CITY_Y - 20, 52, 0);
      SFX.shieldUp();
      r.destroy();
      this.pushHQ();
      return;
    }
    this.streak = 0;
    const dmg = r.getData('dmg') || 10;
    this.cityHP -= dmg;
    SFX.cityHit();
    this.explode(r.x, CITY_Y - 6, 42, 0);
    this.cameras.main.shake(180, 0.008);
    r.destroy();
    this.pushHQ();
    if (this.cityHP <= 0 && !this.gameOver) this.endGame();
  }

  endGame() {
    this.gameOver = true;
    if (this.score > this.best) {
      this.best = this.score;
      try { localStorage.setItem('ironDomeBest', String(this.best)); } catch (e) {}
    }
    this.pushHQ();
    const bg = this.add.rectangle(360, 480, 620, 340, 0x000000, 0.78).setDepth(30);
    const t1 = this.add.text(360, 400, 'سقطت المدينة!', {
      fontFamily: 'Tahoma, Arial', fontSize: '46px', fontStyle: 'bold', color: '#ff5252'
    }).setOrigin(0.5).setDepth(31);
    const t2 = this.add.text(360, 465,
      'النقاط: ' + this.score + '   •   الموجة: ' + this.wave + '\nاعتراضات ناجحة: ' + this.intercepted + '   •   الأفضل: ' + this.best + '\n\nاضغط في أي مكان لإعادة اللعب', {
      fontFamily: 'Tahoma, Arial', fontSize: '24px', color: '#ffffff', align: 'center', lineSpacing: 10
    }).setOrigin(0.5).setDepth(31);
    bg.setInteractive();
    t1.setDepth(31); t2.setDepth(31);
  }

  pushHQ() {
    if (window.updateHQ) {
      window.updateHQ({
        score: this.score, wave: Math.max(1, this.wave), hp: this.cityHP,
        intercepted: this.intercepted,
        strikeReady: this.time.now >= this.strikeReadyAt,
        strikeWait: Math.max(0, (this.strikeReadyAt - this.time.now) / 1000),
        best: this.best, shield: this.shield, streak: this.streak
      });
    }
  }

  update(time, delta) {
    if (this.gameOver) return;
    const dt = delta / 1000;

    // تحديث لوحة القيادة (لعداد الضربة المضادة)
    this.hudTimer += delta;
    if (this.hudTimer > 300) { this.hudTimer = 0; this.pushHQ(); }

    // إعادة إحياء المنصات بعد زمن (داخل الموجة نفسها)
    this.launchers.forEach((L) => {
      if (!L.alive && L.respawnAt && time > L.respawnAt) {
        L.alive = true; L.respawnAt = 0;
        L.sprite.setTexture('launcher'); L.sprite.clearTint();
        this.flash(L.x, L.y, 0xffa726, 20);
      }
    });

    // إطلاق صواريخ الموجة
    if (!this.betweenWaves && this.spawnedThisWave < this.rocketsToSpawn &&
        time - this.lastSpawnAt >= this.spawnInterval) {
      this.spawnRocket(time);
    }

    // حركة صواريخ العدو + أثر ناري
    const dead = [];
    this.rockets.getChildren().forEach((r) => {
      if (!r.active) return;
      r.x += r.getData('vx') * dt;
      r.y += r.getData('vy') * dt;
      if (time - (r.getData('trailAt') || 0) > 55) {
        r.setData('trailAt', time);
        const t = this.add.circle(r.x, r.y + 16, 5, 0xff9800, 0.55).setDepth(4);
        this.tweens.add({ targets: t, alpha: 0, scale: 0.2, duration: 320, onComplete: () => t.destroy() });
      }
      if (r.y >= CITY_Y - 8) dead.push(r);
    });
    dead.forEach((r) => this.cityHit(r));

    // حركة الصواريخ الاعتراضية (ملاحقة)
    const spentI = [];
    this.interceptors.getChildren().forEach((s) => {
      if (!s.active) return;
      const tgt = s.getData('target');
      let tx = s.getData('tx'), ty = s.getData('ty');
      if (tgt && tgt.active) { tx = tgt.x; ty = tgt.y; s.setData({ tx: tx, ty: ty }); }
      const dx = tx - s.x, dy = ty - s.y, len = Math.hypot(dx, dy) || 1;
      const sp = s.getData('speed') * dt;
      s.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      if (len <= Math.max(sp, 14)) { s.setData({ boomX: tx, boomY: ty }); spentI.push(s); }
      else { s.x += (dx / len) * sp; s.y += (dy / len) * sp; }
      if (time - s.getData('born') > 2600) spentI.push(s);
    });
    spentI.forEach((s) => {
      this.explode(s.getData('boomX') ?? s.x, s.getData('boomY') ?? s.y, this.blastRadius, 1);
      s.destroy();
    });

    // حركة صواريخ الضربة المضادة
    const spentS = [];
    this.strikes.getChildren().forEach((s) => {
      if (!s.active) return;
      const L = s.getData('target');
      const tx = s.getData('tx'), ty = s.getData('ty');
      const dx = tx - s.x, dy = ty - s.y, len = Math.hypot(dx, dy) || 1;
      const sp = s.getData('speed') * dt;
      s.rotation = Math.atan2(dy, dx) + Math.PI / 2;
      if (len <= Math.max(sp, 16)) spentS.push(s);
      else { s.x += (dx / len) * sp; s.y += (dy / len) * sp; }
    });
    spentS.forEach((s) => {
      const L = s.getData('target');
      this.explode(s.x, s.y, 74, 0);
      if (L && L.alive) {
        L.alive = false; L.respawnAt = time + 14000;
        L.sprite.setTexture('launcher_dead');
        this.score += 100;
        this.explode(L.x, L.y, 50, 0);
      }
      s.destroy();
      this.pushHQ();
    });

    // انتهاء الموجة؟
    if (!this.betweenWaves && this.spawnedThisWave >= this.rocketsToSpawn &&
        this.rockets.getChildren().length === 0) {
      this.betweenWaves = true;
      this.score += 50;
      this.cityHP = Math.min(100, this.cityHP + 5); // إصلاح جزئي بين الموجات
      this.pushHQ();
      const next = this.wave + 1;
      this.time.delayedCall(1600, () => { if (!this.gameOver) this.startWave(next); });
    }
  }
}

const config = {
  type: Phaser.AUTO,
  parent: 'game',
  width: W,
  height: H,
  backgroundColor: '#0a1830',
  scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_HORIZONTALLY },
  scene: IronDomeScene
};

new Phaser.Game(config);
