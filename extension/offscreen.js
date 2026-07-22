// offscreen.js — htmlGenius 提示音(MV3 service worker 无 DOM/Web Audio,需 offscreen 文档承载)。
// 收到 {type:"play-ding", target:"offscreen"} → 用 Web Audio 合成一声清脆"叮"(无需音频文件)。
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "play-ding" && msg.target === "offscreen") {
    try { playDing(); } catch (e) { /* 非关键 */ }
  }
});

function playDing() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const ctx = new AC();
  if (ctx.state === "suspended") { try { ctx.resume(); } catch (e) {} }
  const now = ctx.currentTime;
  // 两段叠加正弦音(基频 + 五度),指数衰减包络 → 清脆"叮"
  [[880, 0.0], [1320, 0.015]].forEach(([freq, start]) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now + start);
    gain.gain.exponentialRampToValueAtTime(0.28, now + start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + start + 0.5);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.55);
  });
  setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1200);
}
