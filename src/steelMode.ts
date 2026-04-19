export type SteelMode = {
  steelLocal: boolean;
  steelBaseURL: string;
};

export function resolveSteelMode(
  steelBaseUrlEnv?: string,
  steelKey?: string,
): SteelMode {
  if (steelBaseUrlEnv) {
    return {
      steelLocal: true,
      steelBaseURL: steelBaseUrlEnv,
    };
  }

  if (steelKey) {
    return {
      steelLocal: false,
      steelBaseURL: "https://api.steel.dev",
    };
  }

  return {
    steelLocal: true,
    steelBaseURL: "http://localhost:3000",
  };
}
