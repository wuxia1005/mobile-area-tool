if (!Promise.withResolvers) {
  Promise.withResolvers = function () {
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
  };
}
