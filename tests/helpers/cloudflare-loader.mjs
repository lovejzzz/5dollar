const cloudflareStub = `
export const env = {};
export function waitUntil(promise) { return promise; }
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: `data:text/javascript,${encodeURIComponent(cloudflareStub)}`,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
