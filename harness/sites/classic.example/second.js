// The second script sees the first one's top-level lexical declarations.
shared += 1;
var second = { shared: shared, answer: answer, counter: Counter.n(), classOnWindow: typeof window.Counter, letOnWindow: typeof window.shared,
  varDesc: Object.getOwnPropertyDescriptor(globalThis, 'viaVar').configurable };
function failsHere() { return new Error('ext').stack; }
var extStack = failsHere();
