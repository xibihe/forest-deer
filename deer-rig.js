// Tripo 四足走路动画的清理和测量
// 1. cleanQuadrupedWalk：腿和脊柱的旋转拆成「绕身体左右轴的前后摆」+「其余」，
//    前后摆完整保留，侧摆/扭转压掉大半 —— 去掉蹄子横甩、头左右晃
// 2. measureStride：量出着地蹄子往后扫的速度，换算成「动画播放 1 倍速时身体应该走多快」，
//    控制器按这个速度驱动，蹄子就不会在地上打滑
import * as THREE from 'three';

const X = new THREE.Vector3(1, 0, 0);   // 模型 +Z 朝前、+Y 朝上，前后摆就是绕 +X 转

export function cleanQuadrupedWalk(model, clip, { legKeep = 0.25, hoofKeep = 0.5, spineKeep = 0.3 } = {}) {
  model.updateMatrixWorld(true);
  const invModel = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const q = new THREE.Quaternion(), d = new THREE.Quaternion(), tw = new THREE.Quaternion();
  const sw = new THREE.Quaternion(), twInv = new THREE.Quaternion(), I = new THREE.Quaternion();
  const pw = new THREE.Quaternion(), axis = new THREE.Vector3();
  let touched = 0;
  for (const track of clip.tracks) {
    if (!track.name.endsWith('.quaternion')) continue;
    const bone = model.getObjectByName(track.name.slice(0, -'.quaternion'.length));
    if (!bone || !bone.parent) continue;
    const n = bone.name;
    const keep = /Limb_3$/.test(n) ? hoofKeep : /Limb_[0-2]$/.test(n) ? legKeep : /Spine_/.test(n) ? spineKeep : null;
    if (keep === null) continue;
    // 父骨骼在模型空间里的朝向（用绑定姿势近似），把模型 +X 换到父骨骼空间
    bone.parent.getWorldQuaternion(pw).premultiply(invModel);
    axis.copy(X).applyQuaternion(pw.invert()).normalize();
    const bind = bone.quaternion.clone(), bindInv = bind.clone().invert();
    const v = track.values;
    for (let i = 0; i < v.length; i += 4) {
      q.fromArray(v, i);
      d.copy(q).multiply(bindInv);                        // q = d · bind，d 是在父空间里叠加的转动
      const p = d.x * axis.x + d.y * axis.y + d.z * axis.z;
      tw.set(axis.x * p, axis.y * p, axis.z * p, d.w);
      if (tw.lengthSq() < 1e-10) tw.identity(); else tw.normalize();   // 绕 X 的那一份（前后摆）
      sw.copy(d).multiply(twInv.copy(tw).invert());       // d = sw · tw，剩下的是侧摆和扭转
      sw.slerp(I, 1 - keep);
      q.copy(sw).multiply(tw).multiply(bind);
      q.toArray(v, i);
    }
    touched++;
  }
  return touched;
}

// 返回模型本地单位下的「着地蹄子平均后扫速度」（单位/秒）
export function measureStride(model, clip) {
  const bones = [];
  model.traverse((o) => { if (o.isBone) bones.push([o, o.quaternion.clone(), o.position.clone()]); });
  const feet = [];
  model.traverse((o) => { if (/Limb_3$/.test(o.name)) feet.push(o); });
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const N = 64, dt = clip.duration / N, v = new THREE.Vector3();
  const z = feet.map(() => []);
  for (let i = 0; i <= N; i++) {
    mixer.setTime(i * dt);
    model.updateMatrixWorld(true);
    feet.forEach((f, k) => { model.worldToLocal(f.getWorldPosition(v)); z[k].push(v.z); });
  }
  mixer.stopAllAction(); mixer.uncacheRoot(model);
  for (const [b, q, p] of bones) { b.quaternion.copy(q); b.position.copy(p); }   // 恢复绑定姿势
  model.updateMatrixWorld(true);
  let sum = 0, cnt = 0;
  for (const zs of z) for (let i = 0; i < N; i++) {
    const s = (zs[i + 1] - zs[i]) / dt;
    if (s < 0) { sum -= s; cnt++; }
  }
  return cnt ? sum / cnt : 0.6;
}

// 3. retimeQuadrupedWalk：按真鹿的步态重新排每条腿的节奏
//    Tripo 原版每条腿约一半时间悬空，同侧前后腿会同时离地（只剩一侧两条腿撑着 → 看起来瘸）。
//    这里：每条腿悬空只占 swing（默认 30%），四条腿按「左后 → 左前 → 右后 → 右前」各差 1/4 拍，
//    任何时刻至少三条腿着地。每条腿的动作本身不变，只是重新分配时间
const LEG_PHASE = { '1_Left': 0, '0_Left': 0.25, '1_Right': 0.5, '0_Right': 0.75 };

function sampleHoofZ(model, clip, N) {
  const bones = [];
  model.traverse((o) => { if (o.isBone) bones.push([o, o.quaternion.clone(), o.position.clone()]); });
  const feet = {};
  model.traverse((o) => { const m = /(\d_(?:Left|Right))_Limb_3$/.exec(o.name); if (m) feet[m[1]] = o; });
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(clip).play();
  const out = Object.fromEntries(Object.keys(feet).map((k) => [k, []])), v = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    mixer.setTime(clip.duration * i / N);
    model.updateMatrixWorld(true);
    for (const [k, f] of Object.entries(feet)) out[k].push(model.worldToLocal(f.getWorldPosition(v)).z);
  }
  mixer.stopAllAction(); mixer.uncacheRoot(model);
  for (const [b, q, p] of bones) { b.quaternion.copy(q); b.position.copy(p); }
  model.updateMatrixWorld(true);
  return out;
}

export function retimeQuadrupedWalk(model, clip, { swing = 0.25, samples = 60 } = {}) {
  const N = 240, z = sampleHoofZ(model, clip, N);
  // 周期：用一只蹄子前后位置的自相关找
  const ref = z['1_Left'];
  let period = N, bestErr = Infinity;
  for (let p = Math.floor(N / 6); p <= Math.floor(N / 2); p++) {   // 片段里通常有 2–3 个完整周期
    let e = 0; for (let i = 0; i + p < N; i++) e += (ref[i] - ref[i + p]) ** 2;
    e /= N - p;
    if (e < bestErr) { bestErr = e; period = p; }
  }
  // 自相关在 2 倍周期处也会很小，取最小的那个整数倍因子
  for (const div of [3, 2]) {
    const q = Math.round(period / div);
    if (q < N / 8) continue;
    let e = 0; for (let i = 0; i + q < N; i++) e += (ref[i] - ref[i + q]) ** 2;
    if (e / (N - q) < bestErr * 1.5 + 1e-6) { period = q; break; }
  }
  const P = clip.duration * period / N;
  // 每条腿：蹄子最靠后的时刻 = 抬脚，最靠前的时刻 = 落地，中间这段就是悬空
  // （用极值比数「往前走」的帧更稳，不会被一两帧抖动切断）
  const legs = {};
  for (const [k, zs] of Object.entries(z)) {
    // 先做一点平滑，跨一个周期取平均，减掉片段首尾不严格循环的误差
    const avg = new Float64Array(period);
    for (let i = 0; i < period; i++) { let t = 0, c = 0; for (let j = i; j < N; j += period) { t += zs[j]; c++; } avg[i] = t / c; }
    let iMin = 0, iMax = 0;
    for (let i = 1; i < period; i++) { if (avg[i] < avg[iMin]) iMin = i; if (avg[i] > avg[iMax]) iMax = i; }
    const len = ((iMax - iMin) % period + period) % period;
    legs[k] = { s0: iMin / period, sw: Math.max(len, 1) / period };
  }
  // 输出相位 φ → 某条腿在原动画里该取的相位
  const srcPhase = (leg, phi) => {
    const L = legs[leg];
    const psi = ((phi - LEG_PHASE[leg]) % 1 + 1) % 1;
    const u = psi < swing ? L.s0 + (psi / swing) * L.sw
                          : L.s0 + L.sw + ((psi - swing) / (1 - swing)) * (1 - L.sw);
    return ((u % 1) + 1) % 1;
  };
  const legOf = (name) => { const m = /(\d_(?:Left|Right))_Limb_\d$/.exec(name); return m ? m[1] : '1_Left'; };
  const times = new Float32Array(samples + 1);
  for (let i = 0; i <= samples; i++) times[i] = P * i / samples;
  const tracks = clip.tracks.map((tr) => {
    const leg = legOf(tr.name.split('.')[0]);
    const it = tr.createInterpolant(), sz = tr.getValueSize();
    const vals = new Float32Array((samples + 1) * sz);
    for (let i = 0; i <= samples; i++) {
      const t = srcPhase(leg, i / samples) * P;          // 身体和脊柱跟着左后腿的节奏
      vals.set(it.evaluate(Math.min(t, clip.duration)), i * sz);
    }
    return new tr.constructor(tr.name, times, vals);
  });
  const out = new THREE.AnimationClip(clip.name + ':retimed', P, tracks);
  out.userData = { legs, period: P, swing };
  return out;
}

// 4. buildProceduralWalk：不用 Tripo 的走路动画，直接用 IK 在 Tripo 骨骼上生成一段走路
//    · 蹄子轨迹自己定：着地时匀速往后扫（和身体速度一致，不滑），悬空时抬起、前伸、落地
//    · 步态：左后 → 左前 → 右后 → 右前，前腿比同侧后腿晚 frontLag 拍；
//      悬空占 1 - duty，同侧两条腿、两条前腿、两条后腿都不会同时离地（不瘸）
//    · 蹄子只在身体前后平面里动，没有横甩；身体只有很小的上下起伏和横滚
//    · 腿用「上段和下段保持绑定姿势夹角」的三段 IK（四足的腿近似平行四边形），前腿抬起时腕关节额外折叠
const _X = new THREE.Vector3(1, 0, 0), _Z = new THREE.Vector3(0, 0, 1);
export function buildProceduralWalk(model, {
  period = 0.95, duty = 0.7, frontLag = 0.3, samples = 48, excursion = 1.0,
  liftHind = 0.12, liftFront = 0.16, foldFront = 0.9, curlHind = 0.6, curlFront = 0.9,
  bob = 0.014, roll = 0.012,
} = {}) {
  const B = (n) => model.getObjectByName('tripo' + n) || model.getObjectByName('tripo::' + n);
  const saved = [];
  model.traverse((o) => { if (o.isBone) saved.push([o, o.quaternion.clone(), o.position.clone()]); });
  const restore = () => { for (const [b, q, p] of saved) { b.quaternion.copy(q); b.position.copy(p); } model.updateMatrixWorld(true); };
  restore();
  const invM = model.matrixWorld.clone().invert();
  const invQ = model.getWorldQuaternion(new THREE.Quaternion()).invert();
  const P = (o) => o.getWorldPosition(new THREE.Vector3()).applyMatrix4(invM);          // 模型空间位置
  const MQ = (o) => o.getWorldQuaternion(new THREE.Quaternion()).premultiply(invQ);    // 模型空间朝向
  const setMQ = (o, q) => { o.quaternion.copy(MQ(o.parent).invert().multiply(q)); o.updateMatrixWorld(true); };

  const root = B('Root');
  const rootBind = P(root), rootBindQ = MQ(root);
  const LEGS = [['1_Left', 0, false], ['0_Left', frontLag, true], ['1_Right', 0.5, false], ['0_Right', 0.5 + frontLag, true]];
  const legs = LEGS.map(([id, off, front]) => {
    const b = [0, 1, 2, 3].map((j) => B(`${id}_Limb_${j}`));
    const p = b.map(P);
    const seg = [0, 1, 2].map((j) => p[j + 1].clone().sub(p[j]));
    const len = seg.map((s) => Math.hypot(s.y, s.z)), ang = seg.map((s) => Math.atan2(s.y, s.z));
    const theta = ang[2] - ang[0];
    const e1 = Math.atan2(len[0] * Math.sin(ang[0]) + len[2] * Math.sin(ang[2]), len[0] * Math.cos(ang[0]) + len[2] * Math.cos(ang[2]));
    return {
      id, off, front, b, len, theta, dx: seg.map((s) => s.x),
      bend: Math.sign(Math.sin(ang[1] - e1)) || 1, hoofQ: MQ(b[3]),
      ground: p[3].y, zc: p[3].z, height: p[0].y - p[3].y,
    };
  });
  const sw = 1 - duty, E = excursion * Math.min(...legs.map((l) => l.height));
  const Lh = legs.filter((l) => !l.front).reduce((a, l) => a + l.height, 0) / 2;

  // 某条腿在相位 φ 的蹄子目标（模型空间 z/y）+ 腕关节折叠 + 蹄子翻卷
  const target = (l, phi) => {
    const psi = ((phi - l.off) % 1 + 1) % 1;
    let z, y = l.ground, fold = 0;
    if (psi < sw) {
      const s = psi / sw, m = -E * sw / duty;                 // 两端斜率 = 着地时的后扫速度，起落都顺
      const s2 = s * s, s3 = s2 * s;
      z = -E / 2 * (2 * s3 - 3 * s2 + 1) + m * (s3 - 2 * s2 + s) + E / 2 * (-2 * s3 + 3 * s2) + m * (s3 - s2);
      const sl = l.front ? Math.pow(s, 0.85) : s;             // 前腿抬得早一点
      y += (l.front ? liftFront : liftHind) * l.height * Math.pow(Math.sin(Math.PI * sl), 1.5);
      if (l.front) fold = foldFront * Math.pow(Math.sin(Math.PI * sl), 1.2);
    } else {
      z = E / 2 - E * (psi - sw) / duty;
    }
    // 蹄子翻卷：从着地末段（蹄跟离地）开始，悬空前半段最大，落地前放平
    const w0 = 1 - 0.15 * duty, wl = sw + 0.15 * duty;
    const t = (((psi - w0) % 1) + 1) % 1 / wl;
    const curl = t < 1 ? (l.front ? curlFront : curlHind) * Math.pow(Math.sin(Math.PI * t), 1.3) : 0;
    return { z: l.zc + z, y, fold, curl };
  };

  const solveLeg = (l, T) => {
    const p0 = P(l.b[0]);
    const Dz = T.z - p0.z, Dy = T.y - p0.y, aD = Math.atan2(Dy, Dz);
    const th = l.theta - T.fold;                              // 2D 里负方向 = 下段往后折
    const Wz = l.len[0] + l.len[2] * Math.cos(th), Wy = l.len[2] * Math.sin(th);
    const A = Math.hypot(Wz, Wy), phW = Math.atan2(Wy, Wz), b = l.len[1];
    const d = THREE.MathUtils.clamp(Math.hypot(Dz, Dy), Math.abs(A - b) + 1e-4, (A + b) * 0.999);
    const al = Math.acos(THREE.MathUtils.clamp((A * A + d * d - b * b) / (2 * A * d), -1, 1));
    let e1 = aD + al, beta = 0;
    for (const sg of [1, -1]) {
      e1 = aD + sg * al;
      beta = Math.atan2(d * Math.sin(aD) - A * Math.sin(e1), d * Math.cos(aD) - A * Math.cos(e1));
      if ((Math.sign(Math.sin(beta - e1)) || 1) === l.bend) break;
    }
    const angs = [e1 - phW, beta, e1 - phW + th];
    const pts = [p0.clone()];
    for (let j = 0; j < 3; j++) pts.push(pts[j].clone().add(new THREE.Vector3(l.dx[j], l.len[j] * Math.sin(angs[j]), l.len[j] * Math.cos(angs[j]))));
    for (let j = 0; j < 3; j++) {
      const from = P(l.b[j + 1]).sub(P(l.b[j])).normalize();
      const to = pts[j + 1].clone().sub(pts[j]).normalize();
      setMQ(l.b[j], new THREE.Quaternion().setFromUnitVectors(from, to).multiply(MQ(l.b[j])));
    }
    setMQ(l.b[3], new THREE.Quaternion().setFromAxisAngle(_X, T.curl).multiply(l.hoofQ));   // 绕 +X 正转 = 蹄尖往后卷
  };

  const animated = [root, ...legs.flatMap((l) => l.b)];
  const times = new Float32Array(samples + 1);
  const qv = animated.map(() => new Float32Array((samples + 1) * 4));
  const rp = new Float32Array((samples + 1) * 3);
  for (let i = 0; i <= samples; i++) {
    const phi = (i % samples) / samples;
    times[i] = period * i / samples;
    restore();
    // 身体：每个周期两次轻微下沉（两条腿撑地时最低），一次很小的横滚
    const pos = rootBind.clone(); pos.y -= bob * Lh * Math.cos(4 * Math.PI * (phi - 0.04));
    root.position.copy(root.parent.worldToLocal(pos.applyMatrix4(model.matrixWorld)));
    setMQ(root, new THREE.Quaternion().setFromAxisAngle(_Z, roll * Math.sin(2 * Math.PI * phi)).multiply(rootBindQ));
    for (const l of legs) solveLeg(l, target(l, phi));
    animated.forEach((o, k) => {
      o.quaternion.toArray(qv[k], i * 4);
      if (i > 0) {                                            // 四元数保持同一半球，插值不绕远路
        const a = qv[k], o4 = i * 4, p4 = o4 - 4;
        if (a[o4] * a[p4] + a[o4 + 1] * a[p4 + 1] + a[o4 + 2] * a[p4 + 2] + a[o4 + 3] * a[p4 + 3] < 0) for (let c = 0; c < 4; c++) a[o4 + c] *= -1;
      }
    });
    root.position.toArray(rp, i * 3);
  }
  restore();
  const tracks = animated.map((o, k) => new THREE.QuaternionKeyframeTrack(`${o.name}.quaternion`, times, qv[k]));
  tracks.push(new THREE.VectorKeyframeTrack(`${root.name}.position`, times, rp));
  const clip = new THREE.AnimationClip('procedural:walk', period, tracks);
  clip.userData = { sweep: E / (duty * period), E, duty, period, legs: legs.map((l) => ({ id: l.id, height: +l.height.toFixed(3), bend: l.bend })) };
  return clip;
}
