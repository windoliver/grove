export interface ScopeMutationGuard {
  deactivate(): void;
  assertMutable(operation: string): void;
}

export function guardMutableMethods<T extends object>(
  target: T,
  guard: ScopeMutationGuard,
  mutableMethods: readonly string[],
): T {
  const mutable = new Set(mutableMethods);
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      const methodName = String(prop);
      if (mutable.has(methodName)) {
        return (...args: readonly unknown[]) => {
          guard.assertMutable(methodName);
          if (methodName === "putWithCowrite" && typeof args[1] === "function") {
            const [contribution, cowriteFn] = args as readonly [unknown, () => void];
            const guardedCowrite = () => {
              guard.assertMutable(`${methodName}.commit`);
              cowriteFn();
            };
            return Reflect.apply(value, obj, [contribution, guardedCowrite]);
          }
          return Reflect.apply(value, obj, args);
        };
      }
      return (...args: readonly unknown[]) => Reflect.apply(value, obj, args);
    },
  }) as T;
}
