-- Hand-written supplements that aren't in API-Dump.json:
--   * Roblox datatypes (Vector3, CFrame, Color3, ...) and their constructors
--   * Signal/Connection types (referenced by every Event in every class)
--   * Library globals (task, debug extras, etc.)
--   * Instance globals (game, script, workspace, plugin, _G, shared)
--
-- This file is prepended to the generator output so the class bodies that
-- follow can reference these names.

-- ---- EnumItem (declared first because datatypes below reference it) ---

declare class EnumItem
    Name: string
    Value: number
    EnumType: any
end

-- ---- Signals ----------------------------------------------------------

declare class RBXScriptConnection
    Connected: boolean
    Disconnect: (self: RBXScriptConnection) -> ()
end

declare class RBXScriptSignal
    Connect: (self: RBXScriptSignal, listener: (...any) -> ()) -> RBXScriptConnection
    ConnectParallel: (self: RBXScriptSignal, listener: (...any) -> ()) -> RBXScriptConnection
    Once: (self: RBXScriptSignal, listener: (...any) -> ()) -> RBXScriptConnection
    Wait: (self: RBXScriptSignal) -> ...any
end

-- ---- Vector / matrix types -------------------------------------------

declare class Vector2
    X: number
    Y: number
    Magnitude: number
    Unit: Vector2
    Dot: (self: Vector2, other: Vector2) -> number
    Cross: (self: Vector2, other: Vector2) -> number
    Lerp: (self: Vector2, goal: Vector2, alpha: number) -> Vector2
    Min: (self: Vector2, ...Vector2) -> Vector2
    Max: (self: Vector2, ...Vector2) -> Vector2
end
declare Vector2: {
    new: (x: number?, y: number?) -> Vector2,
    zero: Vector2,
    one: Vector2,
    xAxis: Vector2,
    yAxis: Vector2,
}

declare class Vector3
    X: number
    Y: number
    Z: number
    Magnitude: number
    Unit: Vector3
    Dot: (self: Vector3, other: Vector3) -> number
    Cross: (self: Vector3, other: Vector3) -> Vector3
    Lerp: (self: Vector3, goal: Vector3, alpha: number) -> Vector3
    Min: (self: Vector3, ...Vector3) -> Vector3
    Max: (self: Vector3, ...Vector3) -> Vector3
    FuzzyEq: (self: Vector3, other: Vector3, epsilon: number?) -> boolean
    Angle: (self: Vector3, other: Vector3, axis: Vector3?) -> number
end
declare Vector3: {
    new: (x: number?, y: number?, z: number?) -> Vector3,
    FromAxis: (axis: EnumItem) -> Vector3,
    FromNormalId: (normalId: EnumItem) -> Vector3,
    zero: Vector3,
    one: Vector3,
    xAxis: Vector3,
    yAxis: Vector3,
    zAxis: Vector3,
}

declare class Vector3int16
    X: number
    Y: number
    Z: number
end
declare Vector3int16: {
    new: (x: number?, y: number?, z: number?) -> Vector3int16,
}

declare class Vector2int16
    X: number
    Y: number
end
declare Vector2int16: {
    new: (x: number?, y: number?) -> Vector2int16,
}

declare class CFrame
    Position: Vector3
    Rotation: CFrame
    X: number
    Y: number
    Z: number
    LookVector: Vector3
    RightVector: Vector3
    UpVector: Vector3
    XVector: Vector3
    YVector: Vector3
    ZVector: Vector3
    Inverse: (self: CFrame) -> CFrame
    Lerp: (self: CFrame, goal: CFrame, alpha: number) -> CFrame
    Orthonormalize: (self: CFrame) -> CFrame
    ToWorldSpace: (self: CFrame, ...CFrame) -> ...CFrame
    ToObjectSpace: (self: CFrame, ...CFrame) -> ...CFrame
    PointToWorldSpace: (self: CFrame, ...Vector3) -> ...Vector3
    PointToObjectSpace: (self: CFrame, ...Vector3) -> ...Vector3
    VectorToWorldSpace: (self: CFrame, ...Vector3) -> ...Vector3
    VectorToObjectSpace: (self: CFrame, ...Vector3) -> ...Vector3
    GetComponents: (self: CFrame) -> ...number
    ToEulerAnglesXYZ: (self: CFrame) -> (number, number, number)
    ToEulerAnglesYXZ: (self: CFrame) -> (number, number, number)
    ToAxisAngle: (self: CFrame) -> (Vector3, number)
    FuzzyEq: (self: CFrame, other: CFrame, epsilon: number?) -> boolean
end
declare CFrame: {
    new: (...any) -> CFrame,
    fromMatrix: (pos: Vector3, vX: Vector3, vY: Vector3, vZ: Vector3?) -> CFrame,
    fromAxisAngle: (axis: Vector3, angle: number) -> CFrame,
    fromEulerAnglesXYZ: (rx: number, ry: number, rz: number) -> CFrame,
    fromEulerAnglesYXZ: (rx: number, ry: number, rz: number) -> CFrame,
    Angles: (rx: number, ry: number, rz: number) -> CFrame,
    fromOrientation: (rx: number, ry: number, rz: number) -> CFrame,
    lookAt: (at: Vector3, lookAt: Vector3, up: Vector3?) -> CFrame,
    identity: CFrame,
}

-- ---- Color / pixel types ---------------------------------------------

declare class Color3
    R: number
    G: number
    B: number
    Lerp: (self: Color3, goal: Color3, alpha: number) -> Color3
    ToHSV: (self: Color3) -> (number, number, number)
    ToHex: (self: Color3) -> string
end
declare Color3: {
    new: (r: number?, g: number?, b: number?) -> Color3,
    fromRGB: (r: number?, g: number?, b: number?) -> Color3,
    fromHSV: (h: number, s: number, v: number) -> Color3,
    fromHex: (hex: string) -> Color3,
}

declare class BrickColor
    Number: number
    Name: string
    Color: Color3
    R: number
    G: number
    B: number
end
declare BrickColor: {
    new: (...any) -> BrickColor,
    palette: (idx: number) -> BrickColor,
    random: () -> BrickColor,
    White: () -> BrickColor,
    Gray: () -> BrickColor,
    DarkGray: () -> BrickColor,
    Black: () -> BrickColor,
    Red: () -> BrickColor,
    Yellow: () -> BrickColor,
    Green: () -> BrickColor,
    Blue: () -> BrickColor,
}

-- ---- UI sizing/positioning -------------------------------------------

declare class UDim
    Scale: number
    Offset: number
end
declare UDim: {
    new: (scale: number?, offset: number?) -> UDim,
}

declare class UDim2
    X: UDim
    Y: UDim
    Width: UDim
    Height: UDim
    Lerp: (self: UDim2, goal: UDim2, alpha: number) -> UDim2
end
declare UDim2: {
    new: (...any) -> UDim2,
    fromScale: (sx: number, sy: number) -> UDim2,
    fromOffset: (ox: number, oy: number) -> UDim2,
}

declare class Rect
    Min: Vector2
    Max: Vector2
    Width: number
    Height: number
end
declare Rect: {
    new: (...any) -> Rect,
}

-- ---- Range / sequence types ------------------------------------------

declare class NumberRange
    Min: number
    Max: number
end
declare NumberRange: {
    new: (min: number, max: number?) -> NumberRange,
}

declare class NumberSequenceKeypoint
    Time: number
    Value: number
    Envelope: number
end
declare NumberSequenceKeypoint: {
    new: (time: number, value: number, envelope: number?) -> NumberSequenceKeypoint,
}

declare class NumberSequence
    Keypoints: { NumberSequenceKeypoint }
end
declare NumberSequence: {
    new: (...any) -> NumberSequence,
}

declare class ColorSequenceKeypoint
    Time: number
    Value: Color3
end
declare ColorSequenceKeypoint: {
    new: (time: number, value: Color3) -> ColorSequenceKeypoint,
}

declare class ColorSequence
    Keypoints: { ColorSequenceKeypoint }
end
declare ColorSequence: {
    new: (...any) -> ColorSequence,
}

-- ---- Physics / region types ------------------------------------------

declare class Region3
    CFrame: CFrame
    Size: Vector3
    ExpandToGrid: (self: Region3, resolution: number) -> Region3
end
declare Region3: {
    new: (min: Vector3?, max: Vector3?) -> Region3,
}

declare class Region3int16
    Min: Vector3int16
    Max: Vector3int16
end
declare Region3int16: {
    new: (min: Vector3int16?, max: Vector3int16?) -> Region3int16,
}

declare class Ray
    Origin: Vector3
    Direction: Vector3
    Unit: Ray
    ClosestPoint: (self: Ray, point: Vector3) -> Vector3
    Distance: (self: Ray, point: Vector3) -> number
end
declare Ray: {
    new: (origin: Vector3, direction: Vector3) -> Ray,
}

declare class RaycastResult
    Instance: Instance
    Position: Vector3
    Normal: Vector3
    Material: any
    Distance: number
end

declare class RaycastParams
    FilterDescendantsInstances: { Instance }
    FilterType: any
    IgnoreWater: boolean
    CollisionGroup: string
    RespectCanCollide: boolean
end
declare RaycastParams: {
    new: () -> RaycastParams,
}

declare class OverlapParams
    FilterDescendantsInstances: { Instance }
    FilterType: any
    MaxParts: number
    CollisionGroup: string
    RespectCanCollide: boolean
end
declare OverlapParams: {
    new: () -> OverlapParams,
}

declare class PhysicalProperties
    Density: number
    Friction: number
    Elasticity: number
    FrictionWeight: number
    ElasticityWeight: number
end
declare PhysicalProperties: {
    new: (...any) -> PhysicalProperties,
}

-- ---- Other types -----------------------------------------------------

declare class Faces
    Top: boolean
    Bottom: boolean
    Left: boolean
    Right: boolean
    Back: boolean
    Front: boolean
end
declare Faces: {
    new: (...any) -> Faces,
}

declare class Axes
    X: boolean
    Y: boolean
    Z: boolean
    Top: boolean
    Bottom: boolean
    Left: boolean
    Right: boolean
    Back: boolean
    Front: boolean
end
declare Axes: {
    new: (...any) -> Axes,
}

declare class TweenInfo
    Time: number
    EasingStyle: any
    EasingDirection: any
    RepeatCount: number
    Reverses: boolean
    DelayTime: number
end
declare TweenInfo: {
    new: (...any) -> TweenInfo,
}

declare class Random
    NextNumber: (self: Random, min: number?, max: number?) -> number
    NextInteger: (self: Random, min: number, max: number) -> number
    NextUnitVector: (self: Random) -> Vector3
    Clone: (self: Random) -> Random
    Shuffle: (self: Random, tab: { any }) -> ()
end
declare Random: {
    new: (seed: number?) -> Random,
}

declare class Font
    Family: string
    Weight: any
    Style: any
    Bold: boolean
end
declare Font: {
    new: (...any) -> Font,
    fromEnum: (font: any) -> Font,
    fromName: (name: string, weight: any?, style: any?) -> Font,
    fromId: (id: number, weight: any?, style: any?) -> Font,
}

declare class FloatCurveKey
    Time: number
    Value: number
    Interpolation: any
end
declare FloatCurveKey: {
    new: (...any) -> FloatCurveKey,
}

declare class DateTime
    UnixTimestamp: number
    UnixTimestampMillis: number
    ToIsoDate: (self: DateTime) -> string
    ToLocalTime: (self: DateTime) -> { [string]: number }
    ToUniversalTime: (self: DateTime) -> { [string]: number }
end
declare DateTime: {
    now: () -> DateTime,
    fromUnixTimestamp: (unixTime: number) -> DateTime,
    fromUnixTimestampMillis: (unixTime: number) -> DateTime,
    fromUniversalTime: (year: number?, month: number?, day: number?, hour: number?, minute: number?, second: number?, millisecond: number?) -> DateTime,
    fromLocalTime: (year: number?, month: number?, day: number?, hour: number?, minute: number?, second: number?, millisecond: number?) -> DateTime,
    fromIsoDate: (isoDate: string) -> DateTime?,
}

declare class PathWaypoint
    Position: Vector3
    Action: any
end
declare PathWaypoint: {
    new: (position: Vector3?, action: any?) -> PathWaypoint,
}

-- ---- Cloud / opencloud (stubs) ---------------------------------------
-- These appear in newer API entries; declare as opaque classes so the
-- analyzer doesn't fail. Refine when real surface is needed.

declare class OpenCloudModel end

-- ---- Class namespaces (static-method side of `declare class`) --------
--
-- `declare class Instance ... end` only makes Instance a TYPE name; idioms
-- like `Instance.new("Part")` also need Instance as a VALUE namespace.
-- Same pattern for any class with static constructors.

declare Instance: {
    new: (className: string, parent: Instance?) -> Instance,
    fromExisting: (existing: Instance) -> Instance,
}

-- ---- Library globals -------------------------------------------------

declare task: {
    wait: (seconds: number?) -> number,
    spawn: <A...>(functionOrThread: thread | (A...) -> (), A...) -> thread,
    delay: <A...>(duration: number, functionOrThread: thread | (A...) -> (), A...) -> thread,
    defer: <A...>(functionOrThread: thread | (A...) -> (), A...) -> thread,
    cancel: (thread: thread) -> (),
    synchronize: () -> (),
    desynchronize: () -> (),
}

declare shared: { [string]: any }
declare _G: { [string]: any }

-- Top-level Roblox/Luau globals not in Luau's core stdlib that real
-- scripts call constantly. Without these, every `warn(...)`/`tick()`/
-- `wait(0.5)` etc. fires `UnknownSymbol`. Each accounted for tens of
-- errors across the rbxl corpus before being declared.
--
-- Use the value-binding form (`declare name: (sig) -> ret`) rather
-- than `declare function name(...)` — the function form trips Luau's
-- definition-file parser on variadic args ("All declaration parameters
-- must be annotated", "got '...'").
declare warn: (...any) -> ()
declare tick: () -> number
declare elapsedTime: () -> number
declare settings: () -> any
declare UserSettings: () -> any
declare typeof: (value: any) -> string

-- Pre-`task.library` schedulers. Still valid in Roblox today; older
-- scripts use them in place of `task.wait` / `task.spawn` / `task.delay`.
declare wait: (seconds: number?) -> (number, number)
declare spawn: (callback: (...any) -> (), ...any) -> ()
declare delay: (duration: number, callback: (...any) -> (), ...any) -> ()

-- ---- Roblox script globals -------------------------------------------
-- Concrete `game`, `script`, `workspace`, etc. are declared after the
-- generated class bodies so DataModel/Workspace/etc. are already in scope.
-- The generator appends those declarations at the end of its output.
