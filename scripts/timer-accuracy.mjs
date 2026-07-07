// Run from the plugin dir: node scripts/timer-accuracy.mjs
// Manual timer-accuracy probe for fixed-interval loop behavior.
const target = 60_000;
const start = performance.now();
setTimeout(() => {
  const actual = Math.round(performance.now() - start);
  console.log(`target=${target}ms actual=${actual}ms drift=${actual - target}ms`);
}, target);
