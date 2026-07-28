/**
 * The prelude every stealth patch depends on.
 *
 * ## The problem
 *
 * The obvious way to hide `navigator.webdriver` is:
 *
 *     Object.defineProperty(navigator, 'webdriver', { get: () => false })
 *
 * This is worse than doing nothing. In a real Chrome, that getter is native code;
 * after the patch it is an ordinary JavaScript function, and one line of detector
 * says so:
 *
 *     Function.prototype.toString.call(
 *       Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get
 *     )
 *     // real Chrome: "function get webdriver() { [native code] }"
 *     // naive patch: "() => false"
 *
 * A browser that reports `webdriver === false` from a *tampered* getter is not a
 * normal browser. It is an automated browser that is actively lying, which is a
 * smaller and far more interesting population than "automated". That is why
 * Sentinelle weights `fp.function_tostring_tampered` at 25 — it is a
 * bad-stealth detector, not an automation detector.
 *
 * ## The fix
 *
 * Replace `Function.prototype.toString` with a Proxy that returns a native-looking
 * source string for functions we have registered, and defers to the real
 * implementation for everything else.
 *
 * The subtle part is the last line of defence: the proxy must lie about *itself*.
 * `Function.prototype.toString.call(Function.prototype.toString)` must still report
 * `[native code]`, or the tool built to hide the tampering is the tampering.
 *
 * ## What this still does not survive
 *
 * Being honest about the ceiling, because pretending otherwise is how people ship
 * detectable scrapers:
 *
 *  - `Function.prototype.toString` is a Proxy, and Proxies are observable in ways
 *    that are hard to close in general — for example, exotic invariant checks, or
 *    timing differences on a hot path.
 *  - `Error.prepareStackTrace` and stack introspection can reach frames the proxy
 *    does not mediate.
 *  - An isolated world (a fresh same-origin iframe whose realm we did not patch)
 *    gives the detector a clean `Function.prototype.toString`. Real stealth stacks
 *    reinstall on every frame; this one patches the main realm plus new documents,
 *    which covers the demo but is not complete.
 *
 * The honest summary is that this arms race is won by *not needing to patch* —
 * launch flags and CDP overrides fix things at the source and leave nothing behind.
 * The patches exist for the gaps flags cannot reach.
 */

export function nativeShimSource(): string {
  return `
  /* ---- native-function laundering ------------------------------------- */
  const nativeFunctionToString = Function.prototype.toString;
  const fakeSources = new WeakMap();

  const toStringProxy = new Proxy(nativeFunctionToString, {
    apply(target, thisArg, args) {
      if (fakeSources.has(thisArg)) return fakeSources.get(thisArg);
      return Reflect.apply(target, thisArg, args);
    },
  });

  // The proxy must describe itself as native, or it is the loudest object on the page.
  fakeSources.set(toStringProxy, 'function toString() { [native code] }');

  Object.defineProperty(Function.prototype, 'toString', {
    value: toStringProxy,
    writable: true,
    enumerable: false,
    configurable: true,
  });

  /** Register \`fn\` so it stringifies as a native function called \`name\`. */
  function asNative(fn, name) {
    fakeSources.set(fn, 'function ' + name + '() { [native code] }');
    return fn;
  }

  /**
   * Replace an accessor with a native-looking getter, preserving the exact
   * descriptor shape a real accessor has (set: undefined, enumerable: true).
   * Returns false when the property is non-configurable — in which case the right
   * move is to leave it alone rather than throw and abort the whole prelude.
   */
  function defineGetter(target, prop, get, name) {
    const existing = Object.getOwnPropertyDescriptor(target, prop);
    if (existing && !existing.configurable) return false;
    asNative(get, name || ('get ' + prop));
    Object.defineProperty(target, prop, {
      get,
      set: undefined,
      enumerable: existing ? existing.enumerable : true,
      configurable: true,
    });
    return true;
  }

  /** Wrap a method so the wrapper is indistinguishable from the original. */
  function wrapMethod(target, prop, factory) {
    const original = target[prop];
    if (typeof original !== 'function') return false;
    const replacement = factory(original);
    asNative(replacement, prop);
    Object.defineProperty(target, prop, {
      value: replacement,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    return true;
  }

  /**
   * Run a patch in isolation.
   *
   * One patch throwing must not abort the ones after it. A half-applied prelude is
   * the worst outcome available: some tells fixed, some not, plus whatever wreckage
   * the exception left behind.
   */
  function patch(name, fn) {
    try { fn(); } catch (e) { /* a failed patch is a missing patch, not a broken page */ }
  }
`;
}
