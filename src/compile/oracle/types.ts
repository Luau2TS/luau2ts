// Shared types for the @rbxts/types oracle.

export interface PropertyEntry {
  type: string;
  readonly?: boolean;
}

export interface MethodSig {
  returnText: string;
  paramCount: number;
  optionalParams?: number;
  strategy?: { kind: string };
}

export interface ClassEntry {
  extends?: string;
  properties: Record<string, PropertyEntry>;
  methods: Record<string, MethodSig | MethodSig[]>;
}

export interface OracleData {
  classes: Record<string, ClassEntry>;
  instancesIndex: Record<string, string>;
  creatableInstances: Record<string, string>;
  services: Record<string, string>;
  vector3Properties: string[];
}
