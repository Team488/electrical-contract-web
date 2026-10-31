export type Row = Record<string, unknown>;

/** Thrown by handlers; turned into a JSON error response by the router. */
export class HttpError extends Error {
  constructor(public status: number, message: string, public body: Row = {}) {
    super(message);
  }
}

/** Snapshot written by `./gradlew electricalReport --args="--json"` in TeamXbot2026. */
export interface Snapshot {
  source: string;
  /** ContractToUse name (Competition, 2025, 2023, Robox) and display name. */
  contractName?: string;
  robotName?: string;
  gitSha: string | null;
  generatedAt: string;
  canDevices: {
    name: string; bus: string; canId: number; type: string; kind: string;
    pdhPort: string | null; powerFrom: string | null; busPosition: number | null; definedIn?: string | null;
  }[];
  dio: { name: string; channel: number; powerFrom: string | null; definedIn?: string | null }[];
  pwm: { name: string; channel: number; powerFrom: string | null; definedIn?: string | null }[];
  additionalPdh: Record<string, string[]>;
  powerSources: Record<string, string[]>;
  powerBranches: Record<string, string[]>;
  canOrder: { bus: string; canId: number; deviceName: string; busPosition: number }[];
  warnings: string[];
  /** Devices whose mechanism isn't in this robot's readiness set. */
  disabled?: string[];
}
