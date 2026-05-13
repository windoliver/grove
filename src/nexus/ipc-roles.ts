const SAFE_IPC_ROLE_RE = /^[A-Za-z0-9._-]+$/;

export function normalizeIpcRoleHandle(handle: string): string {
  const role = handle.startsWith("@") ? handle.slice(1) : handle;
  if (role.length === 0 || role === "." || role === ".." || !SAFE_IPC_ROLE_RE.test(role)) {
    throw new Error(`Invalid Nexus IPC role handle: ${handle}`);
  }
  return role;
}
