export function defineBackendMethods(Backend, methods) {
  for (const [name, value] of Object.entries(methods)) {
    Object.defineProperty(Backend.prototype, name, {
      value,
      writable: true,
      configurable: true,
    })
  }
}
