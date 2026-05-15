-- AUTO-GENERATED Roblox globals for @luau2ts/analyzer.
-- Source: API-Dump.json (see api-dump/SOURCE.md for version).
-- Regenerate with: node packages/analyzer/scripts/gen-roblox-defs.mjs
--
-- The hand-written supplements (datatypes, libraries, globals like
-- game/script/workspace, task) are appended verbatim from
-- scripts/supplements.d.lua. Order matters: supplements first so
-- datatypes (Vector3, CFrame, RBXScriptSignal, ...) are declared
-- before the class bodies that reference them.

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


-- DataType stubs (not covered by supplements; declared empty so
-- loadDefinitionFile resolves the names — refine in supplements
-- if real members are needed) ------------------------------------

declare class CatalogSearchParams end
declare class DockWidgetPluginGuiInfo end
declare class ProtectedString end
declare class QFont end
declare class RotationCurveKey end
declare class SharedTable end

-- Classes (generated) -------------------------------------------

declare class Instance
    Archivable: boolean
    ClassName: string
    Name: string
    Parent: Instance
    RobloxLocked: boolean
    archivable: boolean
    className: string
    AddTag: (self: Instance, tag: string) -> ()
    ClearAllChildren: (self: Instance) -> ()
    Clone: (self: Instance) -> Instance
    Destroy: (self: Instance) -> ()
    FindFirstAncestor: (self: Instance, name: string) -> Instance
    FindFirstAncestorOfClass: (self: Instance, className: string) -> Instance
    FindFirstAncestorWhichIsA: (self: Instance, className: string) -> Instance
    FindFirstChild: (self: Instance, name: string, recursive: boolean?) -> Instance
    FindFirstChildOfClass: (self: Instance, className: string) -> Instance
    FindFirstChildWhichIsA: (self: Instance, className: string, recursive: boolean?) -> Instance
    FindFirstDescendant: (self: Instance, name: string) -> Instance
    GetActor: (self: Instance) -> Actor
    GetAttribute: (self: Instance, attribute: string) -> any
    GetAttributeChangedSignal: (self: Instance, attribute: string) -> RBXScriptSignal
    GetAttributes: (self: Instance) -> { [string]: any }
    GetChildren: (self: Instance) -> { Instance }
    GetDebugId: (self: Instance, scopeLength: number?) -> string
    GetDescendants: (self: Instance) -> { any }
    GetFullName: (self: Instance) -> string
    GetPropertyChangedSignal: (self: Instance, property: string) -> RBXScriptSignal
    GetTags: (self: Instance) -> { any }
    HasTag: (self: Instance, tag: string) -> boolean
    IsA: (self: Instance, className: string) -> boolean
    IsAncestorOf: (self: Instance, descendant: Instance) -> boolean
    IsDescendantOf: (self: Instance, ancestor: Instance) -> boolean
    IsPropertyModified: (self: Instance, name: string) -> boolean
    Remove: (self: Instance) -> ()
    RemoveTag: (self: Instance, tag: string) -> ()
    ResetPropertyToDefault: (self: Instance, name: string) -> ()
    SetAttribute: (self: Instance, attribute: string, value: any) -> ()
    WaitForChild: (self: Instance, childName: string, timeOut: number?) -> Instance
    children: (self: Instance) -> { Instance }
    clone: (self: Instance) -> Instance
    destroy: (self: Instance) -> ()
    findFirstChild: (self: Instance, name: string, recursive: boolean?) -> Instance
    getChildren: (self: Instance) -> { Instance }
    isA: (self: Instance, className: string) -> boolean
    isDescendantOf: (self: Instance, ancestor: Instance) -> boolean
    remove: (self: Instance) -> ()
    AncestryChanged: RBXScriptSignal
    AttributeChanged: RBXScriptSignal
    Changed: RBXScriptSignal
    ChildAdded: RBXScriptSignal
    ChildRemoved: RBXScriptSignal
    DescendantAdded: RBXScriptSignal
    DescendantRemoving: RBXScriptSignal
    Destroying: RBXScriptSignal
    childAdded: RBXScriptSignal
end

declare class Accoutrement extends Instance
    AttachmentForward: Vector3
    AttachmentPoint: CFrame
    AttachmentPos: Vector3
    AttachmentRight: Vector3
    AttachmentUp: Vector3
end

declare class Accessory extends Accoutrement
    AccessoryType: EnumItem
end

declare class Hat extends Accoutrement
end

declare class AdPortal extends Instance
    Status: EnumItem
end

declare class AdService extends Instance
    ShowVideoAd: (self: AdService) -> ()
    VideoAdClosed: RBXScriptSignal
end

declare class AdvancedDragger extends Instance
end

declare class AnalyticsService extends Instance
    FireCustomEvent: (self: AnalyticsService, player: Instance, eventCategory: string, customData: any) -> ()
    FireEvent: (self: AnalyticsService, category: string, value: any) -> ()
    FireInGameEconomyEvent: (self: AnalyticsService, player: Instance, itemName: string, economyAction: EnumItem, itemCategory: string, amount: number, currency: string, location: any, customData: any) -> ()
    FireLogEvent: (self: AnalyticsService, player: Instance, logLevel: EnumItem, message: string, debugInfo: any, customData: any) -> ()
    FirePlayerProgressionEvent: (self: AnalyticsService, player: Instance, category: string, progressionStatus: EnumItem, location: any, statistics: any, customData: any) -> ()
end

declare class Animation extends Instance
    AnimationId: string
end

declare class AnimationClip extends Instance
    Loop: boolean
    Priority: EnumItem
end

declare class CurveAnimation extends AnimationClip
end

declare class KeyframeSequence extends AnimationClip
    AuthoredHipHeight: number
    AddKeyframe: (self: KeyframeSequence, keyframe: Instance) -> ()
    GetKeyframes: (self: KeyframeSequence) -> { Instance }
    RemoveKeyframe: (self: KeyframeSequence, keyframe: Instance) -> ()
end

declare class AnimationClipProvider extends Instance
    GetAnimationClip: (self: AnimationClipProvider, assetId: string) -> AnimationClip
    GetAnimationClipById: (self: AnimationClipProvider, assetId: number, useCache: boolean) -> AnimationClip
    RegisterActiveAnimationClip: (self: AnimationClipProvider, animationClip: AnimationClip) -> string
    RegisterAnimationClip: (self: AnimationClipProvider, animationClip: AnimationClip) -> string
    GetAnimationClipAsync: (self: AnimationClipProvider, assetId: string) -> AnimationClip
    GetAnimations: (self: AnimationClipProvider, userId: number) -> Instance
end

declare class AnimationController extends Instance
    GetPlayingAnimationTracks: (self: AnimationController) -> { any }
    LoadAnimation: (self: AnimationController, animation: Animation) -> AnimationTrack
    AnimationPlayed: RBXScriptSignal
end

declare class AnimationFromVideoCreatorService extends Instance
end

declare class AnimationFromVideoCreatorStudioService extends Instance
end

declare class AnimationRigData extends Instance
end

declare class AnimationStreamTrack extends Instance
    Animation: TrackerStreamAnimation
    IsPlaying: boolean
    Priority: EnumItem
    WeightCurrent: number
    WeightTarget: number
end

declare class AnimationTrack extends Instance
    Animation: Animation
    IsPlaying: boolean
    Length: number
    Looped: boolean
    Priority: EnumItem
    Speed: number
    TimePosition: number
    WeightCurrent: number
    WeightTarget: number
    AdjustSpeed: (self: AnimationTrack, speed: number?) -> ()
    AdjustWeight: (self: AnimationTrack, weight: number?, fadeTime: number?) -> ()
    GetMarkerReachedSignal: (self: AnimationTrack, name: string) -> RBXScriptSignal
    GetTimeOfKeyframe: (self: AnimationTrack, keyframeName: string) -> number
    Play: (self: AnimationTrack, fadeTime: number?, weight: number?, speed: number?) -> ()
    Stop: (self: AnimationTrack, fadeTime: number?) -> ()
    DidLoop: RBXScriptSignal
    Ended: RBXScriptSignal
    KeyframeReached: RBXScriptSignal
    Stopped: RBXScriptSignal
end

declare class Animator extends Instance
    EvaluationThrottled: boolean
    PreferLodEnabled: boolean
    ApplyJointVelocities: (self: Animator, motors: any) -> ()
    GetPlayingAnimationTracks: (self: Animator) -> { any }
    LoadAnimation: (self: Animator, animation: Animation) -> AnimationTrack
    StepAnimations: (self: Animator, deltaTime: number) -> ()
    AnimationPlayed: RBXScriptSignal
end

declare class AppUpdateService extends Instance
end

declare class AssetCounterService extends Instance
end

declare class AssetDeliveryProxy extends Instance
    Interface: string
    Port: number
    StartServer: boolean
end

declare class AssetImportService extends Instance
end

declare class AssetImportSession extends Instance
    UploadComplete: RBXScriptSignal
    UploadCompleteDeprecated: RBXScriptSignal
    UploadProgress: RBXScriptSignal
end

declare class AssetManagerService extends Instance
end

declare class AssetPatchSettings extends Instance
    ContentId: string
    OutputPath: string
    PatchId: string
end

declare class AssetService extends Instance
    CreatePlaceAsync: (self: AssetService, placeName: string, templatePlaceID: number, description: string?) -> number
    CreatePlaceInPlayerInventoryAsync: (self: AssetService, player: Instance, placeName: string, templatePlaceID: number, description: string?) -> number
    GetAssetIdsForPackage: (self: AssetService, packageAssetId: number) -> { any }
    GetBundleDetailsAsync: (self: AssetService, bundleId: number) -> { [string]: any }
    GetCreatorAssetID: (self: AssetService, creationID: number) -> number
    GetGamePlacesAsync: (self: AssetService) -> Instance
    LoadImageAsync: (self: AssetService, textureId: string) -> DynamicImage
    PromptCreateAssetAsync: (self: AssetService, player: Player, instance: Instance, assetType: EnumItem) -> ...any
    SavePlaceAsync: (self: AssetService) -> ()
    SearchAudio: (self: AssetService, searchParameters: AudioSearchParams) -> AudioPages
end

declare class Atmosphere extends Instance
    Color: Color3
    Decay: Color3
    Density: number
    Glare: number
    Haze: number
    Offset: number
end

declare class Attachment extends Instance
    Axis: Vector3
    CFrame: CFrame
    Orientation: Vector3
    Position: Vector3
    Rotation: Vector3
    SecondaryAxis: Vector3
    Visible: boolean
    WorldAxis: Vector3
    WorldCFrame: CFrame
    WorldOrientation: Vector3
    WorldPosition: Vector3
    WorldRotation: Vector3
    WorldSecondaryAxis: Vector3
    GetAxis: (self: Attachment) -> Vector3
    GetConstraints: (self: Attachment) -> { Instance }
    GetSecondaryAxis: (self: Attachment) -> Vector3
    SetAxis: (self: Attachment, axis: Vector3) -> ()
    SetSecondaryAxis: (self: Attachment, axis: Vector3) -> ()
end

declare class Bone extends Attachment
    Transform: CFrame
    TransformedCFrame: CFrame
    TransformedWorldCFrame: CFrame
end

declare class AudioAnalyzer extends Instance
    PeakLevel: number
    RmsLevel: number
end

declare class AudioChorus extends Instance
    Depth: number
    Mix: number
    Rate: number
end

declare class AudioCompressor extends Instance
    Attack: number
    MakeupGain: number
    Ratio: number
    Release: number
    Threshold: number
end

declare class AudioDeviceInput extends Instance
    AccessType: EnumItem
    Active: boolean
    Muted: boolean
    Player: Player
    GetUserIdAccessList: (self: AudioDeviceInput) -> { any }
    SetUserIdAccessList: (self: AudioDeviceInput, userIds: { any }) -> ()
end

declare class AudioDeviceOutput extends Instance
    Player: Player
end

declare class AudioDistortion extends Instance
    Level: number
end

declare class AudioEcho extends Instance
    DelayTime: number
    DryLevel: number
    Feedback: number
    WetLevel: number
end

declare class AudioEmitter extends Instance
    AudioInteractionGroup: string
end

declare class AudioEqualizer extends Instance
    HighGain: number
    LowGain: number
    MidGain: number
    MidRange: NumberRange
end

declare class AudioFader extends Instance
    Volume: number
end

declare class AudioFlanger extends Instance
    Depth: number
    Mix: number
    Rate: number
end

declare class AudioListener extends Instance
    AudioInteractionGroup: string
end

declare class AudioPitchShifter extends Instance
    Pitch: number
end

declare class AudioPlayer extends Instance
    AssetId: string
    AutoLoad: boolean
    IsPlaying: boolean
    IsReady: boolean
    LoopRegion: NumberRange
    Looping: boolean
    PlaybackRegion: NumberRange
    PlaybackSpeed: number
    TimeLength: number
    TimePosition: number
    Play: (self: AudioPlayer) -> ()
    Stop: (self: AudioPlayer) -> ()
end

declare class AudioReverb extends Instance
    DecayRatio: number
    DecayTime: number
    Density: number
    Diffusion: number
    DryLevel: number
    EarlyDelayTime: number
    HighCutFrequency: number
    LateDelayTime: number
    LowShelfFrequency: number
    LowShelfGain: number
    ReferenceFrequency: number
    WetLevel: number
end

declare class AudioSearchParams extends Instance
    Album: string
    Artist: string
    AudioSubType: EnumItem
    AudioSubtype: EnumItem
    MaxDuration: number
    MinDuration: number
    SearchKeyword: string
    Tag: string
    Title: string
end

declare class AvatarChatService extends Instance
end

declare class AvatarEditorService extends Instance
    GetAccessoryType: (self: AvatarEditorService, avatarAssetType: EnumItem) -> EnumItem
    PromptAllowInventoryReadAccess: (self: AvatarEditorService) -> ()
    PromptCreateOutfit: (self: AvatarEditorService, outfit: HumanoidDescription, rigType: EnumItem) -> ()
    PromptDeleteOutfit: (self: AvatarEditorService, outfitId: number) -> ()
    PromptRenameOutfit: (self: AvatarEditorService, outfitId: number) -> ()
    PromptSaveAvatar: (self: AvatarEditorService, humanoidDescription: HumanoidDescription, rigType: EnumItem) -> ()
    PromptSetFavorite: (self: AvatarEditorService, itemId: number, itemType: EnumItem, shouldFavorite: boolean) -> ()
    PromptUpdateOutfit: (self: AvatarEditorService, outfitId: number, updatedOutfit: HumanoidDescription, rigType: EnumItem) -> ()
    CheckApplyDefaultClothing: (self: AvatarEditorService, humanoidDescription: HumanoidDescription) -> HumanoidDescription
    ConformToAvatarRules: (self: AvatarEditorService, humanoidDescription: HumanoidDescription) -> HumanoidDescription
    GetAvatarRules: (self: AvatarEditorService) -> { [string]: any }
    GetBatchItemDetails: (self: AvatarEditorService, itemIds: { any }, itemType: EnumItem) -> { any }
    GetFavorite: (self: AvatarEditorService, itemId: number, itemType: EnumItem) -> boolean
    GetInventory: (self: AvatarEditorService, assetTypes: { any }) -> InventoryPages
    GetItemDetails: (self: AvatarEditorService, itemId: number, itemType: EnumItem) -> { [string]: any }
    GetOutfitDetails: (self: AvatarEditorService, outfitId: number) -> { [string]: any }
    GetOutfits: (self: AvatarEditorService, outfitSource: EnumItem?, outfitType: EnumItem?) -> OutfitPages
    GetRecommendedAssets: (self: AvatarEditorService, assetType: EnumItem, contextAssetId: number?) -> { any }
    GetRecommendedBundles: (self: AvatarEditorService, bundleId: number) -> { any }
    SearchCatalog: (self: AvatarEditorService, searchParameters: CatalogSearchParams) -> CatalogPages
    PromptAllowInventoryReadAccessCompleted: RBXScriptSignal
    PromptCreateOutfitCompleted: RBXScriptSignal
    PromptDeleteOutfitCompleted: RBXScriptSignal
    PromptRenameOutfitCompleted: RBXScriptSignal
    PromptSaveAvatarCompleted: RBXScriptSignal
    PromptSetFavoriteCompleted: RBXScriptSignal
    PromptUpdateOutfitCompleted: RBXScriptSignal
end

declare class AvatarImportService extends Instance
end

declare class Backpack extends Instance
end

declare class BadgeService extends Instance
    AwardBadge: (self: BadgeService, userId: number, badgeId: number) -> boolean
    GetBadgeInfoAsync: (self: BadgeService, badgeId: number) -> { [string]: any }
    IsDisabled: (self: BadgeService, badgeId: number) -> boolean
    IsLegal: (self: BadgeService, badgeId: number) -> boolean
    UserHasBadge: (self: BadgeService, userId: number, badgeId: number) -> boolean
    UserHasBadgeAsync: (self: BadgeService, userId: number, badgeId: number) -> boolean
end

declare class BaseImportData extends Instance
    Id: string
    ImportName: string
    ShouldImport: boolean
end

declare class AnimationImportData extends BaseImportData
end

declare class FacsImportData extends BaseImportData
end

declare class GroupImportData extends BaseImportData
    Anchored: boolean
    ImportAsModelAsset: boolean
    InsertInWorkspace: boolean
end

declare class JointImportData extends BaseImportData
end

declare class MaterialImportData extends BaseImportData
    DiffuseFilePath: string
    IsPbr: boolean
    MetalnessFilePath: string
    NormalFilePath: string
    RoughnessFilePath: string
end

declare class MeshImportData extends BaseImportData
    Anchored: boolean
    CageManifold: boolean
    CageMeshIntersectedPreview: boolean
    CageMeshNotIntersected: boolean
    CageNoOverlappingVertices: boolean
    CageNonManifoldPreview: boolean
    CageOverlappingVerticesPreview: boolean
    CageUVMatched: boolean
    CageUVMisMatchedPreview: boolean
    Dimensions: Vector3
    DoubleSided: boolean
    IgnoreVertexColors: boolean
    IrrelevantCageModifiedPreview: boolean
    MeshHoleDetectedPreview: boolean
    MeshNoHoleDetected: boolean
    NoIrrelevantCageModified: boolean
    NoOuterCageFarExtendedFromMesh: boolean
    OuterCageFarExtendedFromMeshPreview: boolean
    PolygonCount: number
    UseImportedPivot: boolean
end

declare class RootImportData extends BaseImportData
    AddModelToInventory: boolean
    Anchored: boolean
    AnimationIdForRestPose: number
    ExistingPackageId: string
    FileDimensions: Vector3
    ImportAsModelAsset: boolean
    ImportAsPackage: boolean
    InsertInWorkspace: boolean
    InsertWithScenePosition: boolean
    InvertNegativeFaces: boolean
    MergeMeshes: boolean
    PolygonCount: number
    RestPose: EnumItem
    RigScale: EnumItem
    RigType: EnumItem
    RigVisualization: boolean
    ScaleUnit: EnumItem
    UseSceneOriginAsCFrame: boolean
    UseSceneOriginAsPivot: boolean
    UsesCages: boolean
    WorldForward: EnumItem
    WorldUp: EnumItem
end

declare class BasePlayerGui extends Instance
    GetGuiObjectsAtPosition: (self: BasePlayerGui, x: number, y: number) -> { Instance }
end

declare class CoreGui extends BasePlayerGui
    Version: number
end

declare class PlayerGui extends BasePlayerGui
    CurrentScreenOrientation: EnumItem
    ScreenOrientation: EnumItem
    SelectionImageObject: GuiObject
    GetTopbarTransparency: (self: PlayerGui) -> number
    SetTopbarTransparency: (self: PlayerGui, transparency: number) -> ()
    TopbarTransparencyChangedSignal: RBXScriptSignal
end

declare class StarterGui extends BasePlayerGui
    ProcessUserInput: boolean
    ResetPlayerGuiOnSpawn: boolean
    ScreenOrientation: EnumItem
    ShowDevelopmentGui: boolean
    GetCoreGuiEnabled: (self: StarterGui, coreGuiType: EnumItem) -> boolean
    SetCore: (self: StarterGui, parameterName: string, value: any) -> ()
    SetCoreGuiEnabled: (self: StarterGui, coreGuiType: EnumItem, enabled: boolean) -> ()
    GetCore: (self: StarterGui, parameterName: string) -> any
end

declare class BaseWrap extends Instance
    CageMeshId: string
    CageOrigin: CFrame
    CageOriginWorld: CFrame
    ImportOrigin: CFrame
    ImportOriginWorld: CFrame
end

declare class WrapLayer extends BaseWrap
    AutoSkin: EnumItem
    BindOffset: CFrame
    Enabled: boolean
    Order: number
    Puffiness: number
    ReferenceMeshId: string
    ReferenceOrigin: CFrame
    ReferenceOriginWorld: CFrame
    ShrinkFactor: number
end

declare class WrapTarget extends BaseWrap
    Stiffness: number
end

declare class Beam extends Instance
    Attachment0: Attachment
    Attachment1: Attachment
    Brightness: number
    Color: ColorSequence
    CurveSize0: number
    CurveSize1: number
    Enabled: boolean
    FaceCamera: boolean
    LightEmission: number
    LightInfluence: number
    Segments: number
    Texture: string
    TextureLength: number
    TextureMode: EnumItem
    TextureSpeed: number
    Transparency: NumberSequence
    Width0: number
    Width1: number
    ZOffset: number
    SetTextureOffset: (self: Beam, offset: number?) -> ()
end

declare class BindableEvent extends Instance
    Fire: (self: BindableEvent, ...any) -> ()
    Event: RBXScriptSignal
end

declare class BindableFunction extends Instance
    Invoke: (self: BindableFunction, ...any) -> ...any
    OnInvoke: (...any) -> ...any?
end

declare class BodyMover extends Instance
end

declare class BodyAngularVelocity extends BodyMover
    AngularVelocity: Vector3
    MaxTorque: Vector3
    P: number
    angularvelocity: Vector3
    maxTorque: Vector3
end

declare class BodyForce extends BodyMover
    Force: Vector3
    force: Vector3
end

declare class BodyGyro extends BodyMover
    CFrame: CFrame
    D: number
    MaxTorque: Vector3
    P: number
    cframe: CFrame
    maxTorque: Vector3
end

declare class BodyPosition extends BodyMover
    D: number
    MaxForce: Vector3
    P: number
    Position: Vector3
    maxForce: Vector3
    position: Vector3
    GetLastForce: (self: BodyPosition) -> Vector3
    lastForce: (self: BodyPosition) -> Vector3
    ReachedTarget: RBXScriptSignal
end

declare class BodyThrust extends BodyMover
    Force: Vector3
    Location: Vector3
    force: Vector3
    location: Vector3
end

declare class BodyVelocity extends BodyMover
    MaxForce: Vector3
    P: number
    Velocity: Vector3
    maxForce: Vector3
    velocity: Vector3
    GetLastForce: (self: BodyVelocity) -> Vector3
    lastForce: (self: BodyVelocity) -> Vector3
end

declare class RocketPropulsion extends BodyMover
    CartoonFactor: number
    MaxSpeed: number
    MaxThrust: number
    MaxTorque: Vector3
    Target: BasePart
    TargetOffset: Vector3
    TargetRadius: number
    ThrustD: number
    ThrustP: number
    TurnD: number
    TurnP: number
    Abort: (self: RocketPropulsion) -> ()
    Fire: (self: RocketPropulsion) -> ()
    fire: (self: RocketPropulsion) -> ()
    ReachedTarget: RBXScriptSignal
end

declare class Breakpoint extends Instance
end

declare class BrowserService extends Instance
end

declare class BubbleChatMessageProperties extends Instance
    BackgroundColor3: Color3
    BackgroundTransparency: number
    FontFace: Font
    TextColor3: Color3
    TextSize: number
end

declare class BulkImportService extends Instance
end

declare class CacheableContentProvider extends Instance
end

declare class HSRDataContentProvider extends CacheableContentProvider
end

declare class MeshContentProvider extends CacheableContentProvider
end

declare class SolidModelContentProvider extends CacheableContentProvider
end

declare class CalloutService extends Instance
end

declare class Camera extends Instance
    CFrame: CFrame
    CameraSubject: Instance
    CameraType: EnumItem
    CoordinateFrame: CFrame
    DiagonalFieldOfView: number
    FieldOfView: number
    FieldOfViewMode: EnumItem
    Focus: CFrame
    HeadLocked: boolean
    HeadScale: number
    MaxAxisFieldOfView: number
    NearPlaneZ: number
    VRTiltAndRollEnabled: boolean
    ViewportSize: Vector2
    focus: CFrame
    GetLargestCutoffDistance: (self: Camera, ignoreList: { Instance }) -> number
    GetPanSpeed: (self: Camera) -> number
    GetPartsObscuringTarget: (self: Camera, castPoints: { any }, ignoreList: { Instance }) -> { Instance }
    GetRenderCFrame: (self: Camera) -> CFrame
    GetRoll: (self: Camera) -> number
    GetTiltSpeed: (self: Camera) -> number
    Interpolate: (self: Camera, endPos: CFrame, endFocus: CFrame, duration: number) -> ()
    PanUnits: (self: Camera, units: number) -> ()
    ScreenPointToRay: (self: Camera, x: number, y: number, depth: number?) -> Ray
    SetCameraPanMode: (self: Camera, mode: EnumItem?) -> ()
    SetRoll: (self: Camera, rollAngle: number) -> ()
    TiltUnits: (self: Camera, units: number) -> boolean
    ViewportPointToRay: (self: Camera, x: number, y: number, depth: number?) -> Ray
    WorldToScreenPoint: (self: Camera, worldPoint: Vector3) -> ...any
    WorldToViewportPoint: (self: Camera, worldPoint: Vector3) -> ...any
    ZoomToExtents: (self: Camera, boundingBoxCFrame: CFrame, boundingBoxSize: Vector3) -> ()
    InterpolationFinished: RBXScriptSignal
end

declare class CaptureService extends Instance
end

declare class ChangeHistoryService extends Instance
    FinishRecording: (self: ChangeHistoryService, identifier: string, operation: EnumItem, finalOptions: ({ [string]: any })?) -> ()
    GetCanRedo: (self: ChangeHistoryService) -> ...any
    GetCanUndo: (self: ChangeHistoryService) -> ...any
    IsRecordingInProgress: (self: ChangeHistoryService, identifier: string?) -> boolean
    Redo: (self: ChangeHistoryService) -> ()
    ResetWaypoints: (self: ChangeHistoryService) -> ()
    SetEnabled: (self: ChangeHistoryService, state: boolean) -> ()
    SetWaypoint: (self: ChangeHistoryService, name: string) -> ()
    TryBeginRecording: (self: ChangeHistoryService, name: string, displayName: string?) -> string?
    Undo: (self: ChangeHistoryService) -> ()
    OnRecordingFinished: RBXScriptSignal
    OnRecordingStarted: RBXScriptSignal
    OnRedo: RBXScriptSignal
    OnUndo: RBXScriptSignal
end

declare class CharacterAppearance extends Instance
end

declare class BodyColors extends CharacterAppearance
    HeadColor: BrickColor
    HeadColor3: Color3
    LeftArmColor: BrickColor
    LeftArmColor3: Color3
    LeftLegColor: BrickColor
    LeftLegColor3: Color3
    RightArmColor: BrickColor
    RightArmColor3: Color3
    RightLegColor: BrickColor
    RightLegColor3: Color3
    TorsoColor: BrickColor
    TorsoColor3: Color3
end

declare class CharacterMesh extends CharacterAppearance
    BaseTextureId: number
    BodyPart: EnumItem
    MeshId: number
    OverlayTextureId: number
end

declare class Clothing extends CharacterAppearance
    Color3: Color3
end

declare class Pants extends Clothing
    PantsTemplate: string
end

declare class Shirt extends Clothing
    ShirtTemplate: string
end

declare class ShirtGraphic extends CharacterAppearance
    Color3: Color3
    Graphic: string
end

declare class Skin extends CharacterAppearance
    SkinColor: BrickColor
end

declare class Chat extends Instance
    BubbleChatEnabled: boolean
    LoadDefaultChat: boolean
    Chat: (self: Chat, partOrCharacter: Instance, message: string, color: EnumItem?) -> ()
    InvokeChatCallback: (self: Chat, callbackType: EnumItem, ...any) -> ...any
    RegisterChatCallback: (self: Chat, callbackType: EnumItem, callbackFunction: (...any) -> ...any) -> ()
    SetBubbleChatSettings: (self: Chat, settings: any) -> ()
    CanUserChatAsync: (self: Chat, userId: number) -> boolean
    CanUsersChatAsync: (self: Chat, userIdFrom: number, userIdTo: number) -> boolean
    FilterStringAsync: (self: Chat, stringToFilter: string, playerFrom: Player, playerTo: Player) -> string
    FilterStringForBroadcast: (self: Chat, stringToFilter: string, playerFrom: Player) -> string
    FilterStringForPlayerAsync: (self: Chat, stringToFilter: string, playerToFilterFor: Player) -> string
    Chatted: RBXScriptSignal
end

declare class ClickDetector extends Instance
    CursorIcon: string
    MaxActivationDistance: number
    MouseClick: RBXScriptSignal
    MouseHoverEnter: RBXScriptSignal
    MouseHoverLeave: RBXScriptSignal
    RightMouseClick: RBXScriptSignal
    mouseClick: RBXScriptSignal
end

declare class DragDetector extends ClickDetector
    ActivatedCursorIcon: string
    ApplyAtCenterOfMass: boolean
    Axis: Vector3
    DragFrame: CFrame
    DragStyle: EnumItem
    Enabled: boolean
    GamepadModeSwitchKeyCode: EnumItem
    KeyboardModeSwitchKeyCode: EnumItem
    MaxDragAngle: number
    MaxDragTranslation: Vector3
    MaxForce: number
    MaxTorque: number
    MinDragAngle: number
    MinDragTranslation: Vector3
    Orientation: Vector3
    ReferenceInstance: Instance
    ResponseStyle: EnumItem
    Responsiveness: number
    RunLocally: boolean
    SecondaryAxis: Vector3
    TrackballRadialPullFactor: number
    TrackballRollFactor: number
    VRSwitchKeyCode: EnumItem
    WorldAxis: Vector3
    WorldSecondaryAxis: Vector3
    AddConstraintFunction: (self: DragDetector, priority: number, _function: (...any) -> ...any) -> RBXScriptConnection
    GetReferenceFrame: (self: DragDetector) -> CFrame
    RestartDrag: (self: DragDetector) -> ()
    SetDragStyleFunction: (self: DragDetector, _function: (...any) -> ...any) -> ()
    DragContinue: RBXScriptSignal
    DragEnd: RBXScriptSignal
    DragStart: RBXScriptSignal
end

declare class Clouds extends Instance
    Color: Color3
    Cover: number
    Density: number
    Enabled: boolean
end

declare class ClusterPacketCache extends Instance
end

declare class CollectionService extends Instance
    AddTag: (self: CollectionService, instance: Instance, tag: string) -> ()
    GetAllTags: (self: CollectionService) -> { any }
    GetCollection: (self: CollectionService, class: string) -> { Instance }
    GetInstanceAddedSignal: (self: CollectionService, tag: string) -> RBXScriptSignal
    GetInstanceRemovedSignal: (self: CollectionService, tag: string) -> RBXScriptSignal
    GetTagged: (self: CollectionService, tag: string) -> { Instance }
    GetTags: (self: CollectionService, instance: Instance) -> { any }
    HasTag: (self: CollectionService, instance: Instance, tag: string) -> boolean
    RemoveTag: (self: CollectionService, instance: Instance, tag: string) -> ()
    ItemAdded: RBXScriptSignal
    ItemRemoved: RBXScriptSignal
    TagAdded: RBXScriptSignal
    TagRemoved: RBXScriptSignal
end

declare class CommandInstance extends Instance
    AllowGUIAccessPoints: boolean
    DisplayName: string
    Name: string
end

declare class CommandService extends Instance
end

declare class Configuration extends Instance
end

declare class ConfigureServerService extends Instance
end

declare class Constraint extends Instance
    Active: boolean
    Attachment0: Attachment
    Attachment1: Attachment
    Color: BrickColor
    Enabled: boolean
    Visible: boolean
end

declare class AlignOrientation extends Constraint
    AlignType: EnumItem
    CFrame: CFrame
    LookAtPosition: Vector3
    MaxAngularVelocity: number
    MaxTorque: number
    Mode: EnumItem
    PrimaryAxis: Vector3
    PrimaryAxisOnly: boolean
    ReactionTorqueEnabled: boolean
    Responsiveness: number
    RigidityEnabled: boolean
    SecondaryAxis: Vector3
end

declare class AlignPosition extends Constraint
    ApplyAtCenterOfMass: boolean
    ForceLimitMode: EnumItem
    ForceRelativeTo: EnumItem
    MaxAxesForce: Vector3
    MaxForce: number
    MaxVelocity: number
    Mode: EnumItem
    Position: Vector3
    ReactionForceEnabled: boolean
    Responsiveness: number
    RigidityEnabled: boolean
end

declare class AngularVelocity extends Constraint
    AngularVelocity: Vector3
    MaxTorque: number
    ReactionTorqueEnabled: boolean
    RelativeTo: EnumItem
end

declare class AnimationConstraint extends Constraint
    IsKinematic: boolean
    MaxForce: number
    MaxTorque: number
    Transform: CFrame
end

declare class BallSocketConstraint extends Constraint
    LimitsEnabled: boolean
    MaxFrictionTorque: number
    Radius: number
    Restitution: number
    TwistLimitsEnabled: boolean
    TwistLowerAngle: number
    TwistUpperAngle: number
    UpperAngle: number
end

declare class HingeConstraint extends Constraint
    ActuatorType: EnumItem
    AngularResponsiveness: number
    AngularSpeed: number
    AngularVelocity: number
    CurrentAngle: number
    LimitsEnabled: boolean
    LowerAngle: number
    MotorMaxAcceleration: number
    MotorMaxTorque: number
    Radius: number
    Restitution: number
    ServoMaxTorque: number
    TargetAngle: number
    UpperAngle: number
end

declare class LineForce extends Constraint
    ApplyAtCenterOfMass: boolean
    InverseSquareLaw: boolean
    Magnitude: number
    MaxForce: number
    ReactionForceEnabled: boolean
end

declare class LinearVelocity extends Constraint
    ForceLimitMode: EnumItem
    LineDirection: Vector3
    LineVelocity: number
    MaxAxesForce: Vector3
    MaxForce: number
    MaxPlanarAxesForce: Vector2
    PlaneVelocity: Vector2
    PrimaryTangentAxis: Vector3
    RelativeTo: EnumItem
    SecondaryTangentAxis: Vector3
    VectorVelocity: Vector3
    VelocityConstraintMode: EnumItem
end

declare class PlaneConstraint extends Constraint
end

declare class Plane extends PlaneConstraint
end

declare class RigidConstraint extends Constraint
end

declare class RodConstraint extends Constraint
    CurrentDistance: number
    Length: number
    LimitAngle0: number
    LimitAngle1: number
    LimitsEnabled: boolean
    Thickness: number
end

declare class RopeConstraint extends Constraint
    CurrentDistance: number
    Length: number
    Restitution: number
    Thickness: number
    WinchEnabled: boolean
    WinchForce: number
    WinchResponsiveness: number
    WinchSpeed: number
    WinchTarget: number
end

declare class SlidingBallConstraint extends Constraint
    ActuatorType: EnumItem
    CurrentPosition: number
    LimitsEnabled: boolean
    LinearResponsiveness: number
    LowerLimit: number
    MotorMaxAcceleration: number
    MotorMaxForce: number
    Restitution: number
    ServoMaxForce: number
    Size: number
    Speed: number
    TargetPosition: number
    UpperLimit: number
    Velocity: number
end

declare class CylindricalConstraint extends SlidingBallConstraint
    AngularActuatorType: EnumItem
    AngularLimitsEnabled: boolean
    AngularResponsiveness: number
    AngularRestitution: number
    AngularSpeed: number
    AngularVelocity: number
    CurrentAngle: number
    InclinationAngle: number
    LowerAngle: number
    MotorMaxAngularAcceleration: number
    MotorMaxTorque: number
    RotationAxisVisible: boolean
    ServoMaxTorque: number
    TargetAngle: number
    UpperAngle: number
    WorldRotationAxis: Vector3
end

declare class PrismaticConstraint extends SlidingBallConstraint
end

declare class SpringConstraint extends Constraint
    Coils: number
    CurrentLength: number
    Damping: number
    FreeLength: number
    LimitsEnabled: boolean
    MaxForce: number
    MaxLength: number
    MinLength: number
    Radius: number
    Stiffness: number
    Thickness: number
end

declare class Torque extends Constraint
    RelativeTo: EnumItem
    Torque: Vector3
end

declare class TorsionSpringConstraint extends Constraint
    Coils: number
    CurrentAngle: number
    Damping: number
    LimitEnabled: boolean
    LimitsEnabled: boolean
    MaxAngle: number
    MaxTorque: number
    Radius: number
    Restitution: number
    Stiffness: number
end

declare class UniversalConstraint extends Constraint
    LimitsEnabled: boolean
    MaxAngle: number
    Radius: number
    Restitution: number
end

declare class VectorForce extends Constraint
    ApplyAtCenterOfMass: boolean
    Force: Vector3
    RelativeTo: EnumItem
end

declare class ContentProvider extends Instance
    BaseUrl: string
    RequestQueueSize: number
    GetAssetFetchStatus: (self: ContentProvider, contentId: string) -> EnumItem
    GetAssetFetchStatusChangedSignal: (self: ContentProvider, contentId: string) -> RBXScriptSignal
    ListEncryptedAssets: (self: ContentProvider) -> { any }
    Preload: (self: ContentProvider, contentId: string) -> ()
    RegisterDefaultEncryptionKey: (self: ContentProvider, encryptionKey: string) -> ()
    RegisterDefaultSessionKey: (self: ContentProvider, sessionKey: string) -> ()
    RegisterEncryptedAsset: (self: ContentProvider, assetId: string, encryptionKey: string) -> ()
    RegisterSessionEncryptedAsset: (self: ContentProvider, contentId: string, sessionKey: string) -> ()
    UnregisterDefaultEncryptionKey: (self: ContentProvider) -> ()
    UnregisterEncryptedAsset: (self: ContentProvider, assetId: string) -> ()
    PreloadAsync: (self: ContentProvider, contentIdList: { any }, callbackFunction: (...any) -> ...any?) -> ()
    AssetFetchFailed: RBXScriptSignal
end

declare class ContextActionService extends Instance
    BindAction: (self: ContextActionService, actionName: string, functionToBind: (...any) -> ...any, createTouchButton: boolean, ...any) -> ()
    BindActionAtPriority: (self: ContextActionService, actionName: string, functionToBind: (...any) -> ...any, createTouchButton: boolean, priorityLevel: number, ...any) -> ()
    BindActionToInputTypes: (self: ContextActionService, actionName: string, functionToBind: (...any) -> ...any, createTouchButton: boolean, ...any) -> ()
    BindActivate: (self: ContextActionService, userInputTypeForActivation: EnumItem, ...any) -> ()
    GetAllBoundActionInfo: (self: ContextActionService) -> { [string]: any }
    GetBoundActionInfo: (self: ContextActionService, actionName: string) -> { [string]: any }
    GetCurrentLocalToolIcon: (self: ContextActionService) -> string
    SetDescription: (self: ContextActionService, actionName: string, description: string) -> ()
    SetImage: (self: ContextActionService, actionName: string, image: string) -> ()
    SetPosition: (self: ContextActionService, actionName: string, position: UDim2) -> ()
    SetTitle: (self: ContextActionService, actionName: string, title: string) -> ()
    UnbindAction: (self: ContextActionService, actionName: string) -> ()
    UnbindActivate: (self: ContextActionService, userInputTypeForActivation: EnumItem, keyCodeForActivation: EnumItem?) -> ()
    UnbindAllActions: (self: ContextActionService) -> ()
    GetButton: (self: ContextActionService, actionName: string) -> Instance
    LocalToolEquipped: RBXScriptSignal
    LocalToolUnequipped: RBXScriptSignal
end

declare class Controller extends Instance
    BindButton: (self: Controller, button: EnumItem, caption: string) -> ()
    GetButton: (self: Controller, button: EnumItem) -> boolean
    UnbindButton: (self: Controller, button: EnumItem) -> ()
    bindButton: (self: Controller, button: EnumItem, caption: string) -> ()
    getButton: (self: Controller, button: EnumItem) -> boolean
    ButtonChanged: RBXScriptSignal
end

declare class HumanoidController extends Controller
end

declare class SkateboardController extends Controller
    Steer: number
    Throttle: number
    AxisChanged: RBXScriptSignal
end

declare class VehicleController extends Controller
end

declare class ControllerBase extends Instance
    Active: boolean
    BalanceRigidityEnabled: boolean
    MoveSpeedFactor: number
end

declare class AirController extends ControllerBase
    BalanceMaxTorque: number
    BalanceSpeed: number
    LinearImpulse: Vector3
    MaintainAngularMomentum: boolean
    MaintainLinearMomentum: boolean
    MoveMaxForce: number
    TurnMaxTorque: number
    TurnSpeedFactor: number
end

declare class ClimbController extends ControllerBase
    AccelerationTime: number
    BalanceMaxTorque: number
    BalanceSpeed: number
    MoveMaxForce: number
end

declare class GroundController extends ControllerBase
    AccelerationLean: number
    AccelerationTime: number
    BalanceMaxTorque: number
    BalanceSpeed: number
    DecelerationTime: number
    Friction: number
    FrictionWeight: number
    GroundOffset: number
    StandForce: number
    StandSpeed: number
    TurnSpeedFactor: number
end

declare class SwimController extends ControllerBase
    AccelerationTime: number
    PitchMaxTorque: number
    PitchSpeedFactor: number
    RollMaxTorque: number
    RollSpeedFactor: number
end

declare class ControllerManager extends Instance
    ActiveController: ControllerBase
    BaseMoveSpeed: number
    BaseTurnSpeed: number
    ClimbSensor: ControllerSensor
    FacingDirection: Vector3
    GroundSensor: ControllerSensor
    MovingDirection: Vector3
    RootPart: BasePart
end

declare class ControllerService extends Instance
end

declare class CookiesService extends Instance
end

declare class CorePackages extends Instance
end

declare class CoreScriptDebuggingManagerHelper extends Instance
end

declare class CoreScriptSyncService extends Instance
end

declare class CrossDMScriptChangeListener extends Instance
end

declare class CustomEvent extends Instance
    GetAttachedReceivers: (self: CustomEvent) -> { Instance }
    SetValue: (self: CustomEvent, newValue: number) -> ()
    ReceiverConnected: RBXScriptSignal
    ReceiverDisconnected: RBXScriptSignal
end

declare class CustomEventReceiver extends Instance
    Source: Instance
    GetCurrentValue: (self: CustomEventReceiver) -> number
    EventConnected: RBXScriptSignal
    EventDisconnected: RBXScriptSignal
    SourceValueChanged: RBXScriptSignal
end

declare class DataModelMesh extends Instance
    Offset: Vector3
    Scale: Vector3
    VertexColor: Vector3
end

declare class BevelMesh extends DataModelMesh
end

declare class BlockMesh extends BevelMesh
end

declare class CylinderMesh extends BevelMesh
end

declare class DynamicMesh extends DataModelMesh
    AddTriangle: (self: DynamicMesh, vertexId0: number, vertexId1: number, vertexId2: number) -> number
    AddVertex: (self: DynamicMesh, p: Vector3) -> number
    FindClosestPointOnSurface: (self: DynamicMesh, point: Vector3) -> ...any
    FindClosestVertex: (self: DynamicMesh, toThisPoint: Vector3) -> number
    FindVerticesWithinSphere: (self: DynamicMesh, center: Vector3, radius: number) -> { any }
    GetAdjacentTriangles: (self: DynamicMesh, triangleId: number) -> { any }
    GetAdjacentVertices: (self: DynamicMesh, vertexId: number) -> { any }
    GetPosition: (self: DynamicMesh, vertexId: number) -> Vector3
    GetTriangleVertices: (self: DynamicMesh, triangleId: number) -> ...any
    GetTriangles: (self: DynamicMesh) -> { any }
    GetUV: (self: DynamicMesh, vertexId: number) -> Vector2
    GetVertexColor: (self: DynamicMesh, vertexId: number) -> Color3
    GetVertexColorAlpha: (self: DynamicMesh, vertexId: number) -> number
    GetVertexNormal: (self: DynamicMesh, vertexId: number) -> Vector3
    GetVertices: (self: DynamicMesh) -> { any }
    InitializeFromMeshIdAsync: (self: DynamicMesh, meshId: string) -> ()
    InitializeFromMeshPartAsync: (self: DynamicMesh, meshPart: Instance) -> ()
    Raycast: (self: DynamicMesh, origin: Vector3, direction: Vector3) -> ...any
    RemoveTriangle: (self: DynamicMesh, triangleId: number) -> ()
    RemoveVertex: (self: DynamicMesh, vertexId: number) -> ()
    SetPosition: (self: DynamicMesh, vertexId: number, p: Vector3) -> ()
    SetUV: (self: DynamicMesh, vertexId: number, uv: Vector2) -> ()
    SetVertexColor: (self: DynamicMesh, vertexId: number, color: Color3) -> ()
    SetVertexColorAlpha: (self: DynamicMesh, vertexId: number, alpha: number) -> ()
    SetVertexNormal: (self: DynamicMesh, vertexId: number, vnormal: Vector3) -> ()
    CreateMeshPartAsync: (self: DynamicMesh, collisionFidelity: EnumItem) -> MeshPart
end

declare class FileMesh extends DataModelMesh
    MeshId: string
    TextureId: string
end

declare class SpecialMesh extends FileMesh
    MeshType: EnumItem
end

declare class DataModelPatchService extends Instance
end

declare class DataModelSession extends Instance
end

declare class DataStoreIncrementOptions extends Instance
    GetMetadata: (self: DataStoreIncrementOptions) -> { [string]: any }
    SetMetadata: (self: DataStoreIncrementOptions, attributes: { [string]: any }) -> ()
end

declare class DataStoreInfo extends Instance
    CreatedTime: number
    DataStoreName: string
    UpdatedTime: number
end

declare class DataStoreKey extends Instance
    KeyName: string
end

declare class DataStoreKeyInfo extends Instance
    CreatedTime: number
    UpdatedTime: number
    Version: string
    GetMetadata: (self: DataStoreKeyInfo) -> { [string]: any }
    GetUserIds: (self: DataStoreKeyInfo) -> { any }
end

declare class DataStoreObjectVersionInfo extends Instance
    CreatedTime: number
    IsDeleted: boolean
    Version: string
end

declare class DataStoreOptions extends Instance
    AllScopes: boolean
    SetExperimentalFeatures: (self: DataStoreOptions, experimentalFeatures: { [string]: any }) -> ()
end

declare class DataStoreService extends Instance
    GetDataStore: (self: DataStoreService, name: string, scope: string?, options: Instance?) -> GlobalDataStore
    GetGlobalDataStore: (self: DataStoreService) -> GlobalDataStore
    GetOrderedDataStore: (self: DataStoreService, name: string, scope: string?) -> OrderedDataStore
    GetRequestBudgetForRequestType: (self: DataStoreService, requestType: EnumItem) -> number
    ListDataStoresAsync: (self: DataStoreService, prefix: string?, pageSize: number?, cursor: string?) -> DataStoreListingPages
end

declare class DataStoreSetOptions extends Instance
    GetMetadata: (self: DataStoreSetOptions) -> { [string]: any }
    SetMetadata: (self: DataStoreSetOptions, attributes: { [string]: any }) -> ()
end

declare class Debris extends Instance
    MaxItems: number
    AddItem: (self: Debris, item: Instance, lifetime: number?) -> ()
    addItem: (self: Debris, item: Instance, lifetime: number?) -> ()
end

declare class DebugSettings extends Instance
    DataModel: number
    InstanceCount: number
    IsScriptStackTracingEnabled: boolean
    JobCount: number
    PlayerCount: number
    ReportSoundWarnings: boolean
    RobloxVersion: string
    TickCountPreciseOverride: EnumItem
end

declare class DebuggablePluginWatcher extends Instance
end

declare class DebuggerBreakpoint extends Instance
    Condition: string
    ContinueExecution: boolean
    IsEnabled: boolean
    Line: number
    LogExpression: string
    isContextDependentBreakpoint: boolean
end

declare class DebuggerConnection extends Instance
end

declare class LocalDebuggerConnection extends DebuggerConnection
end

declare class DebuggerConnectionManager extends Instance
end

declare class DebuggerLuaResponse extends Instance
end

declare class DebuggerManager extends Instance
    DebuggingEnabled: boolean
    AddDebugger: (self: DebuggerManager, script: Instance) -> Instance
    GetDebuggers: (self: DebuggerManager) -> { Instance }
    Resume: (self: DebuggerManager) -> ()
    StepIn: (self: DebuggerManager) -> ()
    StepOut: (self: DebuggerManager) -> ()
    StepOver: (self: DebuggerManager) -> ()
    DebuggerAdded: RBXScriptSignal
    DebuggerRemoved: RBXScriptSignal
end

declare class DebuggerUIService extends Instance
end

declare class DebuggerVariable extends Instance
end

declare class DebuggerWatch extends Instance
    Expression: string
end

declare class DeviceIdService extends Instance
end

declare class Dialog extends Instance
    BehaviorType: EnumItem
    ConversationDistance: number
    GoodbyeChoiceActive: boolean
    GoodbyeDialog: string
    InUse: boolean
    InitialPrompt: string
    Purpose: EnumItem
    Tone: EnumItem
    TriggerDistance: number
    TriggerOffset: Vector3
    GetCurrentPlayers: (self: Dialog) -> { Instance }
    DialogChoiceSelected: RBXScriptSignal
end

declare class DialogChoice extends Instance
    GoodbyeChoiceActive: boolean
    GoodbyeDialog: string
    ResponseDialog: string
    UserDialog: string
end

declare class DraftsService extends Instance
end

declare class Dragger extends Instance
    AxisRotate: (self: Dragger, axis: EnumItem?) -> ()
    MouseDown: (self: Dragger, mousePart: Instance, pointOnMousePart: Vector3, parts: { Instance }) -> ()
    MouseMove: (self: Dragger, mouseRay: Ray) -> ()
    MouseUp: (self: Dragger) -> ()
end

declare class DraggerService extends Instance
    AlignDraggedObjects: boolean
    AngleSnapEnabled: boolean
    AngleSnapIncrement: number
    AnimateHover: boolean
    CollisionsEnabled: boolean
    DraggerCoordinateSpace: EnumItem
    DraggerMovementMode: EnumItem
    GeometrySnapColor: Color3
    HoverAnimateFrequency: number
    HoverThickness: number
    JointsEnabled: boolean
    LinearSnapEnabled: boolean
    LinearSnapIncrement: number
    ShowHover: boolean
    ShowPivotIndicator: boolean
end

declare class DynamicImage extends Instance
    Size: Vector2
    Clear: (self: DynamicImage) -> ()
    DrawCircle: (self: DynamicImage, center: Vector2, radius: number, color: Color3, transparency: number) -> ()
    ReadPixels: (self: DynamicImage, position: Vector2, size: Vector2) -> { any }
    Resize: (self: DynamicImage, newSize: Vector2) -> ()
    Rotate: (self: DynamicImage, degrees: number, resizeCanvas: boolean?) -> ()
    WritePixels: (self: DynamicImage, position: Vector2, size: Vector2, pixels: { any }) -> ()
end

declare class EulerRotationCurve extends Instance
    RotationOrder: EnumItem
    GetAnglesAtTime: (self: EulerRotationCurve, time: number) -> { any }
    GetRotationAtTime: (self: EulerRotationCurve, time: number) -> CFrame
    X: (self: EulerRotationCurve) -> FloatCurve
    Y: (self: EulerRotationCurve) -> FloatCurve
    Z: (self: EulerRotationCurve) -> FloatCurve
end

declare class EventIngestService extends Instance
end

declare class ExperienceAuthService extends Instance
end

declare class ExperienceInviteOptions extends Instance
    InviteMessageId: string
    InviteUser: number
    LaunchData: string
    PromptMessage: string
end

declare class Explosion extends Instance
    BlastPressure: number
    BlastRadius: number
    DestroyJointRadiusPercent: number
    ExplosionType: EnumItem
    Position: Vector3
    TimeScale: number
    Visible: boolean
    Hit: RBXScriptSignal
end

declare class FaceAnimatorService extends Instance
end

declare class FaceControls extends Instance
    ChinRaiser: number
    ChinRaiserUpperLip: number
    Corrugator: number
    EyesLookDown: number
    EyesLookLeft: number
    EyesLookRight: number
    EyesLookUp: number
    FlatPucker: number
    Funneler: number
    JawDrop: number
    JawLeft: number
    JawRight: number
    LeftBrowLowerer: number
    LeftCheekPuff: number
    LeftCheekRaiser: number
    LeftDimpler: number
    LeftEyeClosed: number
    LeftEyeUpperLidRaiser: number
    LeftInnerBrowRaiser: number
    LeftLipCornerDown: number
    LeftLipCornerPuller: number
    LeftLipStretcher: number
    LeftLowerLipDepressor: number
    LeftNoseWrinkler: number
    LeftOuterBrowRaiser: number
    LeftUpperLipRaiser: number
    LipPresser: number
    LipsTogether: number
    LowerLipSuck: number
    MouthLeft: number
    MouthRight: number
    Pucker: number
    RightBrowLowerer: number
    RightCheekPuff: number
    RightCheekRaiser: number
    RightDimpler: number
    RightEyeClosed: number
    RightEyeUpperLidRaiser: number
    RightInnerBrowRaiser: number
    RightLipCornerDown: number
    RightLipCornerPuller: number
    RightLipStretcher: number
    RightLowerLipDepressor: number
    RightNoseWrinkler: number
    RightOuterBrowRaiser: number
    RightUpperLipRaiser: number
    TongueDown: number
    TongueOut: number
    TongueUp: number
    UpperLipSuck: number
end

declare class FaceInstance extends Instance
    Face: EnumItem
end

declare class Decal extends FaceInstance
    Color3: Color3
    LocalTransparencyModifier: number
    Shiny: number
    Specular: number
    Texture: string
    Transparency: number
    ZIndex: number
end

declare class Texture extends Decal
    OffsetStudsU: number
    OffsetStudsV: number
    StudsPerTileU: number
    StudsPerTileV: number
end

declare class FacialAnimationRecordingService extends Instance
end

declare class FacialAnimationStreamingServiceStats extends Instance
end

declare class FacialAnimationStreamingServiceV2 extends Instance
end

declare class FacialAnimationStreamingSubsessionStats extends Instance
end

declare class Feature extends Instance
    FaceId: EnumItem
    InOut: EnumItem
    LeftRight: EnumItem
    TopBottom: EnumItem
end

declare class Hole extends Feature
end

declare class MotorFeature extends Feature
end

declare class File extends Instance
    Size: number
    GetBinaryContents: (self: File) -> string
    GetTemporaryId: (self: File) -> string
end

declare class Fire extends Instance
    Color: Color3
    Enabled: boolean
    Heat: number
    SecondaryColor: Color3
    Size: number
    TimeScale: number
    size: number
end

declare class FlagStandService extends Instance
end

declare class FloatCurve extends Instance
    Length: number
    GetKeyAtIndex: (self: FloatCurve, index: number) -> FloatCurveKey
    GetKeyIndicesAtTime: (self: FloatCurve, time: number) -> { any }
    GetKeys: (self: FloatCurve) -> { any }
    GetValueAtTime: (self: FloatCurve, time: number) -> number?
    InsertKey: (self: FloatCurve, key: FloatCurveKey) -> { any }
    RemoveKeyAtIndex: (self: FloatCurve, startingIndex: number, count: number?) -> number
    SetKeys: (self: FloatCurve, keys: { any }) -> number
end

declare class FlyweightService extends Instance
end

declare class CSGDictionaryService extends FlyweightService
end

declare class NonReplicatedCSGDictionaryService extends FlyweightService
end

declare class Folder extends Instance
end

declare class ForceField extends Instance
    Visible: boolean
end

declare class FriendService extends Instance
end

declare class FunctionalTest extends Instance
    Description: string
    Error: (self: FunctionalTest, message: string?) -> ()
    Failed: (self: FunctionalTest, message: string?) -> ()
    Pass: (self: FunctionalTest, message: string?) -> ()
    Passed: (self: FunctionalTest, message: string?) -> ()
    Warn: (self: FunctionalTest, message: string?) -> ()
end

declare class GamePassService extends Instance
    PlayerHasPass: (self: GamePassService, player: Player, gamePassId: number) -> boolean
end

declare class GameSettings extends Instance
    VideoCaptureEnabled: boolean
end

declare class GamepadService extends Instance
    GamepadCursorEnabled: boolean
    DisableGamepadCursor: (self: GamepadService) -> ()
    EnableGamepadCursor: (self: GamepadService, guiObject: Instance) -> ()
end

declare class Geometry extends Instance
end

declare class GeometryService extends Instance
    CalculateConstraintsToPreserve: (self: GeometryService, source: Instance, destination: { Instance }, options: any) -> { [string]: any }
    IntersectAsync: (self: GeometryService, part: Instance, parts: { Instance }, options: any) -> { Instance }
    SubtractAsync: (self: GeometryService, part: Instance, parts: { Instance }, options: any) -> { Instance }
    UnionAsync: (self: GeometryService, part: Instance, parts: { Instance }, options: any) -> { Instance }
end

declare class GetTextBoundsParams extends Instance
    Font: Font
    Size: number
    Text: string
    Width: number
end

declare class GlobalDataStore extends Instance
    OnUpdate: (self: GlobalDataStore, key: string, callback: (...any) -> ...any) -> RBXScriptConnection
    GetAsync: (self: GlobalDataStore, key: string) -> ...any
    IncrementAsync: (self: GlobalDataStore, key: string, delta: number?, userIds: { any }?, options: DataStoreIncrementOptions?) -> any
    RemoveAsync: (self: GlobalDataStore, key: string) -> ...any
    SetAsync: (self: GlobalDataStore, key: string, value: any, userIds: { any }?, options: DataStoreSetOptions?) -> any
    UpdateAsync: (self: GlobalDataStore, key: string, transformFunction: (...any) -> ...any) -> ...any
end

declare class DataStore extends GlobalDataStore
    GetVersionAsync: (self: DataStore, key: string, version: string) -> ...any
    ListKeysAsync: (self: DataStore, prefix: string?, pageSize: number?, cursor: string?, excludeDeleted: boolean?) -> DataStoreKeyPages
    ListVersionsAsync: (self: DataStore, key: string, sortDirection: EnumItem?, minDate: number?, maxDate: number?, pageSize: number?) -> DataStoreVersionPages
    RemoveVersionAsync: (self: DataStore, key: string, version: string) -> ()
end

declare class OrderedDataStore extends GlobalDataStore
    GetSortedAsync: (self: OrderedDataStore, ascending: boolean, pagesize: number, minValue: any, maxValue: any) -> Instance
end

declare class GoogleAnalyticsConfiguration extends Instance
end

declare class GroupService extends Instance
    GetAlliesAsync: (self: GroupService, groupId: number) -> StandardPages
    GetEnemiesAsync: (self: GroupService, groupId: number) -> StandardPages
    GetGroupInfoAsync: (self: GroupService, groupId: number) -> any
    GetGroupsAsync: (self: GroupService, userId: number) -> { any }
end

declare class GuiBase extends Instance
end

declare class GuiBase2d extends GuiBase
    AbsolutePosition: Vector2
    AbsoluteRotation: number
    AbsoluteSize: Vector2
    AutoLocalize: boolean
    Localize: boolean
    RootLocalizationTable: LocalizationTable
    SelectionBehaviorDown: EnumItem
    SelectionBehaviorLeft: EnumItem
    SelectionBehaviorRight: EnumItem
    SelectionBehaviorUp: EnumItem
    SelectionGroup: boolean
    SelectionChanged: RBXScriptSignal
end

declare class GuiObject extends GuiBase2d
    Active: boolean
    AnchorPoint: Vector2
    AutomaticSize: EnumItem
    BackgroundColor: BrickColor
    BackgroundColor3: Color3
    BackgroundTransparency: number
    BorderColor: BrickColor
    BorderColor3: Color3
    BorderMode: EnumItem
    BorderSizePixel: number
    ClipsDescendants: boolean
    Draggable: boolean
    GuiState: EnumItem
    LayoutOrder: number
    NextSelectionDown: GuiObject
    NextSelectionLeft: GuiObject
    NextSelectionRight: GuiObject
    NextSelectionUp: GuiObject
    Position: UDim2
    Rotation: number
    Selectable: boolean
    SelectionImageObject: GuiObject
    SelectionOrder: number
    Size: UDim2
    SizeConstraint: EnumItem
    Transparency: number
    Visible: boolean
    ZIndex: number
    TweenPosition: (self: GuiObject, endPosition: UDim2, easingDirection: EnumItem?, easingStyle: EnumItem?, time: number?, override: boolean?, callback: (...any) -> ...any?) -> boolean
    TweenSize: (self: GuiObject, endSize: UDim2, easingDirection: EnumItem?, easingStyle: EnumItem?, time: number?, override: boolean?, callback: (...any) -> ...any?) -> boolean
    TweenSizeAndPosition: (self: GuiObject, endSize: UDim2, endPosition: UDim2, easingDirection: EnumItem?, easingStyle: EnumItem?, time: number?, override: boolean?, callback: (...any) -> ...any?) -> boolean
    DragBegin: RBXScriptSignal
    DragStopped: RBXScriptSignal
    InputBegan: RBXScriptSignal
    InputChanged: RBXScriptSignal
    InputEnded: RBXScriptSignal
    MouseEnter: RBXScriptSignal
    MouseLeave: RBXScriptSignal
    MouseMoved: RBXScriptSignal
    MouseWheelBackward: RBXScriptSignal
    MouseWheelForward: RBXScriptSignal
    SelectionGained: RBXScriptSignal
    SelectionLost: RBXScriptSignal
    TouchLongPress: RBXScriptSignal
    TouchPan: RBXScriptSignal
    TouchPinch: RBXScriptSignal
    TouchRotate: RBXScriptSignal
    TouchSwipe: RBXScriptSignal
    TouchTap: RBXScriptSignal
end

declare class CanvasGroup extends GuiObject
    GroupColor3: Color3
    GroupTransparency: number
end

declare class Frame extends GuiObject
    Style: EnumItem
end

declare class GuiButton extends GuiObject
    AutoButtonColor: boolean
    Modal: boolean
    Selected: boolean
    Style: EnumItem
    Activated: RBXScriptSignal
    MouseButton1Click: RBXScriptSignal
    MouseButton1Down: RBXScriptSignal
    MouseButton1Up: RBXScriptSignal
    MouseButton2Click: RBXScriptSignal
    MouseButton2Down: RBXScriptSignal
    MouseButton2Up: RBXScriptSignal
end

declare class ImageButton extends GuiButton
    HoverImage: string
    Image: string
    ImageColor3: Color3
    ImageRectOffset: Vector2
    ImageRectSize: Vector2
    ImageTransparency: number
    IsLoaded: boolean
    PressedImage: string
    ResampleMode: EnumItem
    ScaleType: EnumItem
    SliceCenter: Rect
    SliceScale: number
    TileSize: UDim2
end

declare class TextButton extends GuiButton
    ContentText: string
    Font: EnumItem
    FontFace: Font
    FontSize: EnumItem
    LineHeight: number
    LocalizedText: string
    MaxVisibleGraphemes: number
    RichText: boolean
    Text: string
    TextBounds: Vector2
    TextColor: BrickColor
    TextColor3: Color3
    TextDirection: EnumItem
    TextFits: boolean
    TextScaled: boolean
    TextSize: number
    TextStrokeColor3: Color3
    TextStrokeTransparency: number
    TextTransparency: number
    TextTruncate: EnumItem
    TextWrap: boolean
    TextWrapped: boolean
    TextXAlignment: EnumItem
    TextYAlignment: EnumItem
end

declare class GuiLabel extends GuiObject
end

declare class ImageLabel extends GuiLabel
    Image: string
    ImageColor3: Color3
    ImageRectOffset: Vector2
    ImageRectSize: Vector2
    ImageTransparency: number
    IsLoaded: boolean
    ResampleMode: EnumItem
    ScaleType: EnumItem
    SliceCenter: Rect
    SliceScale: number
    TileSize: UDim2
end

declare class TextLabel extends GuiLabel
    ContentText: string
    Font: EnumItem
    FontFace: Font
    FontSize: EnumItem
    LineHeight: number
    LocalizedText: string
    MaxVisibleGraphemes: number
    RichText: boolean
    Text: string
    TextBounds: Vector2
    TextColor: BrickColor
    TextColor3: Color3
    TextDirection: EnumItem
    TextFits: boolean
    TextScaled: boolean
    TextSize: number
    TextStrokeColor3: Color3
    TextStrokeTransparency: number
    TextTransparency: number
    TextTruncate: EnumItem
    TextWrap: boolean
    TextWrapped: boolean
    TextXAlignment: EnumItem
    TextYAlignment: EnumItem
end

declare class ScrollingFrame extends GuiObject
    AbsoluteCanvasSize: Vector2
    AbsoluteWindowSize: Vector2
    AutomaticCanvasSize: EnumItem
    BottomImage: string
    CanvasPosition: Vector2
    CanvasSize: UDim2
    ElasticBehavior: EnumItem
    HorizontalScrollBarInset: EnumItem
    MidImage: string
    ScrollBarImageColor3: Color3
    ScrollBarImageTransparency: number
    ScrollBarThickness: number
    ScrollingDirection: EnumItem
    ScrollingEnabled: boolean
    TopImage: string
    VerticalScrollBarInset: EnumItem
    VerticalScrollBarPosition: EnumItem
end

declare class TextBox extends GuiObject
    ClearTextOnFocus: boolean
    ContentText: string
    CursorPosition: number
    Font: EnumItem
    FontFace: Font
    FontSize: EnumItem
    LineHeight: number
    MaxVisibleGraphemes: number
    MultiLine: boolean
    PlaceholderColor3: Color3
    PlaceholderText: string
    RichText: boolean
    SelectionStart: number
    ShowNativeInput: boolean
    Text: string
    TextBounds: Vector2
    TextColor: BrickColor
    TextColor3: Color3
    TextDirection: EnumItem
    TextEditable: boolean
    TextFits: boolean
    TextScaled: boolean
    TextSize: number
    TextStrokeColor3: Color3
    TextStrokeTransparency: number
    TextTransparency: number
    TextTruncate: EnumItem
    TextWrap: boolean
    TextWrapped: boolean
    TextXAlignment: EnumItem
    TextYAlignment: EnumItem
    CaptureFocus: (self: TextBox) -> ()
    IsFocused: (self: TextBox) -> boolean
    ReleaseFocus: (self: TextBox, submitted: boolean?) -> ()
    FocusLost: RBXScriptSignal
    Focused: RBXScriptSignal
    ReturnPressedFromOnScreenKeyboard: RBXScriptSignal
end

declare class VideoFrame extends GuiObject
    IsLoaded: boolean
    Looped: boolean
    Playing: boolean
    Resolution: Vector2
    TimeLength: number
    TimePosition: number
    Video: string
    Volume: number
    Pause: (self: VideoFrame) -> ()
    Play: (self: VideoFrame) -> ()
    DidLoop: RBXScriptSignal
    Ended: RBXScriptSignal
    Loaded: RBXScriptSignal
    Paused: RBXScriptSignal
    Played: RBXScriptSignal
end

declare class ViewportFrame extends GuiObject
    Ambient: Color3
    CurrentCamera: Camera
    ImageColor3: Color3
    ImageTransparency: number
    LightColor: Color3
    LightDirection: Vector3
end

declare class LayerCollector extends GuiBase2d
    Enabled: boolean
    ResetOnSpawn: boolean
    ZIndexBehavior: EnumItem
    GetLayoutNodeTree: (self: LayerCollector) -> { [string]: any }
end

declare class BillboardGui extends LayerCollector
    Active: boolean
    Adornee: Instance
    AlwaysOnTop: boolean
    Brightness: number
    ClipsDescendants: boolean
    CurrentDistance: number
    DistanceLowerLimit: number
    DistanceStep: number
    DistanceUpperLimit: number
    ExtentsOffset: Vector3
    ExtentsOffsetWorldSpace: Vector3
    LightInfluence: number
    MaxDistance: number
    PlayerToHideFrom: Instance
    Size: UDim2
    SizeOffset: Vector2
    StudsOffset: Vector3
    StudsOffsetWorldSpace: Vector3
end

declare class PluginGui extends LayerCollector
    Title: string
    BindToClose: (self: PluginGui, _function: (...any) -> ...any?) -> ()
    GetRelativeMousePosition: (self: PluginGui) -> Vector2
    PluginDragDropped: RBXScriptSignal
    PluginDragEntered: RBXScriptSignal
    PluginDragLeft: RBXScriptSignal
    PluginDragMoved: RBXScriptSignal
    WindowFocusReleased: RBXScriptSignal
    WindowFocused: RBXScriptSignal
end

declare class DockWidgetPluginGui extends PluginGui
    HostWidgetWasRestored: boolean
end

declare class QWidgetPluginGui extends PluginGui
end

declare class ScreenGui extends LayerCollector
    ClipToDeviceSafeArea: boolean
    DisplayOrder: number
    IgnoreGuiInset: boolean
    SafeAreaCompatibility: EnumItem
    ScreenInsets: EnumItem
end

declare class GuiMain extends ScreenGui
end

declare class SurfaceGuiBase extends LayerCollector
    Active: boolean
    Adornee: Instance
    Face: EnumItem
end

declare class AdGui extends SurfaceGuiBase
    AdShape: EnumItem
    FallbackImage: string
    Status: EnumItem
end

declare class SurfaceGui extends SurfaceGuiBase
    AlwaysOnTop: boolean
    Brightness: number
    CanvasSize: Vector2
    ClipsDescendants: boolean
    LightInfluence: number
    PixelsPerStud: number
    SizingMode: EnumItem
    ToolPunchThroughDistance: number
    ZOffset: number
end

declare class GuiBase3d extends GuiBase
    Color: BrickColor
    Color3: Color3
    Transparency: number
    Visible: boolean
end

declare class FloorWire extends GuiBase3d
    CycleOffset: number
    From: BasePart
    StudsBetweenTextures: number
    Texture: string
    TextureSize: Vector2
    To: BasePart
    Velocity: number
    WireRadius: number
end

declare class InstanceAdornment extends GuiBase3d
    Adornee: Instance
end

declare class SelectionBox extends InstanceAdornment
    LineThickness: number
    SurfaceColor: BrickColor
    SurfaceColor3: Color3
    SurfaceTransparency: number
end

declare class PVAdornment extends GuiBase3d
    Adornee: PVInstance
end

declare class HandleAdornment extends PVAdornment
    AdornCullingMode: EnumItem
    AlwaysOnTop: boolean
    CFrame: CFrame
    SizeRelativeOffset: Vector3
    ZIndex: number
    MouseButton1Down: RBXScriptSignal
    MouseButton1Up: RBXScriptSignal
    MouseEnter: RBXScriptSignal
    MouseLeave: RBXScriptSignal
end

declare class BoxHandleAdornment extends HandleAdornment
    Size: Vector3
end

declare class ConeHandleAdornment extends HandleAdornment
    Height: number
    Radius: number
end

declare class CylinderHandleAdornment extends HandleAdornment
    Angle: number
    Height: number
    InnerRadius: number
    Radius: number
end

declare class ImageHandleAdornment extends HandleAdornment
    Image: string
    Size: Vector2
end

declare class LineHandleAdornment extends HandleAdornment
    Length: number
    Thickness: number
end

declare class SphereHandleAdornment extends HandleAdornment
    Radius: number
end

declare class WireframeHandleAdornment extends HandleAdornment
    Scale: Vector3
    AddLine: (self: WireframeHandleAdornment, from: Vector3, to: Vector3) -> ()
    AddLines: (self: WireframeHandleAdornment, points: { any }) -> ()
    AddPath: (self: WireframeHandleAdornment, points: { any }, loop: boolean) -> ()
    Clear: (self: WireframeHandleAdornment) -> ()
end

declare class ParabolaAdornment extends PVAdornment
end

declare class SelectionSphere extends PVAdornment
    SurfaceColor: BrickColor
    SurfaceColor3: Color3
    SurfaceTransparency: number
end

declare class PartAdornment extends GuiBase3d
    Adornee: BasePart
end

declare class HandlesBase extends PartAdornment
end

declare class ArcHandles extends HandlesBase
    Axes: Axes
    MouseButton1Down: RBXScriptSignal
    MouseButton1Up: RBXScriptSignal
    MouseDrag: RBXScriptSignal
    MouseEnter: RBXScriptSignal
    MouseLeave: RBXScriptSignal
end

declare class Handles extends HandlesBase
    Faces: Faces
    Style: EnumItem
    MouseButton1Down: RBXScriptSignal
    MouseButton1Up: RBXScriptSignal
    MouseDrag: RBXScriptSignal
    MouseEnter: RBXScriptSignal
    MouseLeave: RBXScriptSignal
end

declare class SurfaceSelection extends PartAdornment
    TargetSurface: EnumItem
end

declare class SelectionLasso extends GuiBase3d
    Humanoid: Humanoid
end

declare class SelectionPartLasso extends SelectionLasso
    Part: BasePart
end

declare class SelectionPointLasso extends SelectionLasso
    Point: Vector3
end

declare class GuiService extends Instance
    AutoSelectGuiEnabled: boolean
    CoreGuiNavigationEnabled: boolean
    GuiNavigationEnabled: boolean
    IsModalDialog: boolean
    IsWindows: boolean
    MenuIsOpen: boolean
    PreferredTransparency: number
    ReducedMotionEnabled: boolean
    SelectedObject: GuiObject
    TouchControlsEnabled: boolean
    AddSelectionParent: (self: GuiService, selectionName: string, selectionParent: Instance) -> ()
    AddSelectionTuple: (self: GuiService, selectionName: string, ...any) -> ()
    CloseInspectMenu: (self: GuiService) -> ()
    GetEmotesMenuOpen: (self: GuiService) -> boolean
    GetGameplayPausedNotificationEnabled: (self: GuiService) -> boolean
    GetGuiInset: (self: GuiService) -> ...any
    GetInspectMenuEnabled: (self: GuiService) -> boolean
    InspectPlayerFromHumanoidDescription: (self: GuiService, humanoidDescription: Instance, name: string) -> ()
    InspectPlayerFromUserId: (self: GuiService, userId: number) -> ()
    IsTenFootInterface: (self: GuiService) -> boolean
    RemoveSelectionGroup: (self: GuiService, selectionName: string) -> ()
    Select: (self: GuiService, selectionParent: Instance) -> ()
    SetEmotesMenuOpen: (self: GuiService, isOpen: boolean) -> ()
    SetGameplayPausedNotificationEnabled: (self: GuiService, enabled: boolean) -> ()
    SetInspectMenuEnabled: (self: GuiService, enabled: boolean) -> ()
    MenuClosed: RBXScriptSignal
    MenuOpened: RBXScriptSignal
end

declare class GuidRegistryService extends Instance
end

declare class HapticService extends Instance
    GetMotor: (self: HapticService, inputType: EnumItem, vibrationMotor: EnumItem) -> ...any
    IsMotorSupported: (self: HapticService, inputType: EnumItem, vibrationMotor: EnumItem) -> boolean
    IsVibrationSupported: (self: HapticService, inputType: EnumItem) -> boolean
    SetMotor: (self: HapticService, inputType: EnumItem, vibrationMotor: EnumItem, ...any) -> ()
end

declare class HeightmapImporterService extends Instance
end

declare class HiddenSurfaceRemovalAsset extends Instance
end

declare class Highlight extends Instance
    Adornee: Instance
    DepthMode: EnumItem
    Enabled: boolean
    FillColor: Color3
    FillTransparency: number
    OutlineColor: Color3
    OutlineTransparency: number
end

declare class Hopper extends Instance
end

declare class HttpRbxApiService extends Instance
    RequestLimitedAsync: (self: HttpRbxApiService, requestOptions: { [string]: any }, priority: EnumItem?, content_type: EnumItem?, httpRequestType: EnumItem?) -> string
end

declare class HttpRequest extends Instance
end

declare class HttpService extends Instance
    GenerateGUID: (self: HttpService, wrapInCurlyBraces: boolean?) -> string
    JSONDecode: (self: HttpService, input: string) -> any
    JSONEncode: (self: HttpService, input: any) -> string
    UrlEncode: (self: HttpService, input: string) -> string
    GetAsync: (self: HttpService, url: string, nocache: boolean?, headers: any) -> string
    PostAsync: (self: HttpService, url: string, data: string, content_type: EnumItem?, compress: boolean?, headers: any) -> string
    RequestAsync: (self: HttpService, requestOptions: { [string]: any }) -> { [string]: any }
end

declare class Humanoid extends Instance
    AutoJumpEnabled: boolean
    AutoRotate: boolean
    AutomaticScalingEnabled: boolean
    BreakJointsOnDeath: boolean
    CameraOffset: Vector3
    CollisionType: EnumItem
    DisplayDistanceType: EnumItem
    DisplayName: string
    EvaluateStateMachine: boolean
    FloorMaterial: EnumItem
    Health: number
    HealthDisplayDistance: number
    HealthDisplayType: EnumItem
    HipHeight: number
    Jump: boolean
    JumpHeight: number
    JumpPower: number
    LeftLeg: BasePart
    MaxHealth: number
    MaxSlopeAngle: number
    MoveDirection: Vector3
    NameDisplayDistance: number
    NameOcclusion: EnumItem
    PlatformStand: boolean
    RequiresNeck: boolean
    RigType: EnumItem
    RightLeg: BasePart
    RootPart: BasePart
    SeatPart: BasePart
    Sit: boolean
    TargetPoint: Vector3
    Torso: BasePart
    UseJumpPower: boolean
    WalkSpeed: number
    WalkToPart: BasePart
    WalkToPoint: Vector3
    maxHealth: number
    AddAccessory: (self: Humanoid, accessory: Instance) -> ()
    AddCustomStatus: (self: Humanoid, status: string) -> boolean
    AddStatus: (self: Humanoid, status: EnumItem?) -> boolean
    BuildRigFromAttachments: (self: Humanoid) -> ()
    ChangeState: (self: Humanoid, state: EnumItem?) -> ()
    EquipTool: (self: Humanoid, tool: Instance) -> ()
    GetAccessories: (self: Humanoid) -> { any }
    GetAppliedDescription: (self: Humanoid) -> HumanoidDescription
    GetBodyPartR15: (self: Humanoid, part: Instance) -> EnumItem
    GetLimb: (self: Humanoid, part: Instance) -> EnumItem
    GetMoveVelocity: (self: Humanoid) -> Vector3
    GetPlayingAnimationTracks: (self: Humanoid) -> { any }
    GetState: (self: Humanoid) -> EnumItem
    GetStateEnabled: (self: Humanoid, state: EnumItem) -> boolean
    GetStatuses: (self: Humanoid) -> { any }
    HasCustomStatus: (self: Humanoid, status: string) -> boolean
    HasStatus: (self: Humanoid, status: EnumItem?) -> boolean
    LoadAnimation: (self: Humanoid, animation: Animation) -> AnimationTrack
    Move: (self: Humanoid, moveDirection: Vector3, relativeToCamera: boolean?) -> ()
    MoveTo: (self: Humanoid, location: Vector3, part: Instance?) -> ()
    RemoveAccessories: (self: Humanoid) -> ()
    RemoveCustomStatus: (self: Humanoid, status: string) -> boolean
    RemoveStatus: (self: Humanoid, status: EnumItem?) -> boolean
    ReplaceBodyPartR15: (self: Humanoid, bodyPart: EnumItem, part: BasePart) -> boolean
    SetStateEnabled: (self: Humanoid, state: EnumItem, enabled: boolean) -> ()
    TakeDamage: (self: Humanoid, amount: number) -> ()
    UnequipTools: (self: Humanoid) -> ()
    loadAnimation: (self: Humanoid, animation: Animation) -> AnimationTrack
    takeDamage: (self: Humanoid, amount: number) -> ()
    ApplyDescription: (self: Humanoid, humanoidDescription: HumanoidDescription, assetTypeVerification: EnumItem?) -> ()
    ApplyDescriptionReset: (self: Humanoid, humanoidDescription: HumanoidDescription, assetTypeVerification: EnumItem?) -> ()
    PlayEmote: (self: Humanoid, emoteName: string) -> boolean
    AnimationPlayed: RBXScriptSignal
    Climbing: RBXScriptSignal
    CustomStatusAdded: RBXScriptSignal
    CustomStatusRemoved: RBXScriptSignal
    Died: RBXScriptSignal
    FallingDown: RBXScriptSignal
    FreeFalling: RBXScriptSignal
    GettingUp: RBXScriptSignal
    HealthChanged: RBXScriptSignal
    Jumping: RBXScriptSignal
    MoveToFinished: RBXScriptSignal
    PlatformStanding: RBXScriptSignal
    Ragdoll: RBXScriptSignal
    Running: RBXScriptSignal
    Seated: RBXScriptSignal
    StateChanged: RBXScriptSignal
    StateEnabledChanged: RBXScriptSignal
    StatusAdded: RBXScriptSignal
    StatusRemoved: RBXScriptSignal
    Strafing: RBXScriptSignal
    Swimming: RBXScriptSignal
    Touched: RBXScriptSignal
end

declare class HumanoidDescription extends Instance
    BackAccessory: string
    BodyTypeScale: number
    ClimbAnimation: number
    DepthScale: number
    Face: number
    FaceAccessory: string
    FallAnimation: number
    FrontAccessory: string
    GraphicTShirt: number
    HairAccessory: string
    HatAccessory: string
    Head: number
    HeadColor: Color3
    HeadScale: number
    HeightScale: number
    IdleAnimation: number
    JumpAnimation: number
    LeftArm: number
    LeftArmColor: Color3
    LeftLeg: number
    LeftLegColor: Color3
    MoodAnimation: number
    NeckAccessory: string
    Pants: number
    ProportionScale: number
    RightArm: number
    RightArmColor: Color3
    RightLeg: number
    RightLegColor: Color3
    RunAnimation: number
    Shirt: number
    ShouldersAccessory: string
    SwimAnimation: number
    Torso: number
    TorsoColor: Color3
    WaistAccessory: string
    WalkAnimation: number
    WidthScale: number
    AddEmote: (self: HumanoidDescription, name: string, assetId: number) -> ()
    GetAccessories: (self: HumanoidDescription, includeRigidAccessories: boolean) -> { any }
    GetEmotes: (self: HumanoidDescription) -> { [string]: any }
    GetEquippedEmotes: (self: HumanoidDescription) -> { any }
    RemoveEmote: (self: HumanoidDescription, name: string) -> ()
    SetAccessories: (self: HumanoidDescription, accessories: { any }, includeRigidAccessories: boolean) -> ()
    SetEmotes: (self: HumanoidDescription, emotes: { [string]: any }) -> ()
    SetEquippedEmotes: (self: HumanoidDescription, equippedEmotes: { any }) -> ()
    EmotesChanged: RBXScriptSignal
    EquippedEmotesChanged: RBXScriptSignal
end

declare class IKControl extends Instance
    ChainRoot: Instance
    Enabled: boolean
    EndEffector: Instance
    EndEffectorOffset: CFrame
    Offset: CFrame
    Pole: Instance
    Priority: number
    SmoothTime: number
    Target: Instance
    Type: EnumItem
    Weight: number
    GetChainCount: (self: IKControl) -> number
    GetChainLength: (self: IKControl) -> number
    GetNodeLocalCFrame: (self: IKControl, index: number) -> CFrame
    GetNodeWorldCFrame: (self: IKControl, index: number) -> CFrame
    GetRawFinalTarget: (self: IKControl) -> CFrame
    GetSmoothedFinalTarget: (self: IKControl) -> CFrame
end

declare class ILegacyStudioBridge extends Instance
end

declare class LegacyStudioBridge extends ILegacyStudioBridge
end

declare class IXPService extends Instance
end

declare class IncrementalPatchBuilder extends Instance
    AddPathsToBundle: boolean
    BuildDebouncePeriod: number
    HighCompression: boolean
    SerializePatch: boolean
    ZstdCompression: boolean
end

declare class InputObject extends Instance
    Delta: Vector3
    KeyCode: EnumItem
    Position: Vector3
    UserInputState: EnumItem
    UserInputType: EnumItem
    IsModifierKeyDown: (self: InputObject, modifierKey: EnumItem) -> boolean
end

declare class InsertService extends Instance
    AllowInsertFreeModels: boolean
    ApproveAssetId: (self: InsertService, assetId: number) -> ()
    ApproveAssetVersionId: (self: InsertService, assetVersionId: number) -> ()
    Insert: (self: InsertService, instance: Instance) -> ()
    CreateMeshPartAsync: (self: InsertService, meshId: string, collisionFidelity: EnumItem, renderFidelity: EnumItem) -> MeshPart
    GetBaseCategories: (self: InsertService) -> { any }
    GetBaseSets: (self: InsertService) -> { any }
    GetCollection: (self: InsertService, categoryId: number) -> { any }
    GetFreeDecals: (self: InsertService, searchText: string, pageNum: number) -> { any }
    GetFreeModels: (self: InsertService, searchText: string, pageNum: number) -> { any }
    GetLatestAssetVersionAsync: (self: InsertService, assetId: number) -> number
    GetUserCategories: (self: InsertService, userId: number) -> { any }
    GetUserSets: (self: InsertService, userId: number) -> { any }
    LoadAsset: (self: InsertService, assetId: number) -> Instance
    LoadAssetVersion: (self: InsertService, assetVersionId: number) -> Instance
    loadAsset: (self: InsertService, assetId: number) -> Instance
end

declare class JointInstance extends Instance
    Active: boolean
    C0: CFrame
    C1: CFrame
    Enabled: boolean
    Part0: BasePart
    Part1: BasePart
    part1: BasePart
end

declare class DynamicRotate extends JointInstance
    BaseAngle: number
end

declare class RotateP extends DynamicRotate
end

declare class RotateV extends DynamicRotate
end

declare class Glue extends JointInstance
    F0: Vector3
    F1: Vector3
    F2: Vector3
    F3: Vector3
end

declare class ManualSurfaceJointInstance extends JointInstance
end

declare class ManualGlue extends ManualSurfaceJointInstance
end

declare class ManualWeld extends ManualSurfaceJointInstance
end

declare class Motor extends JointInstance
    CurrentAngle: number
    DesiredAngle: number
    MaxVelocity: number
    SetDesiredAngle: (self: Motor, value: number) -> ()
end

declare class Motor6D extends Motor
    Transform: CFrame
end

declare class Rotate extends JointInstance
end

declare class Snap extends JointInstance
end

declare class VelocityMotor extends JointInstance
    CurrentAngle: number
    DesiredAngle: number
    Hole: Hole
    MaxVelocity: number
end

declare class Weld extends JointInstance
end

declare class JointsService extends Instance
    ClearJoinAfterMoveJoints: (self: JointsService) -> ()
    CreateJoinAfterMoveJoints: (self: JointsService) -> ()
    SetJoinAfterMoveInstance: (self: JointsService, joinInstance: Instance) -> ()
    SetJoinAfterMoveTarget: (self: JointsService, joinTarget: Instance) -> ()
    ShowPermissibleJoints: (self: JointsService) -> ()
end

declare class KeyboardService extends Instance
end

declare class Keyframe extends Instance
    Time: number
    AddMarker: (self: Keyframe, marker: Instance) -> ()
    AddPose: (self: Keyframe, pose: Instance) -> ()
    GetMarkers: (self: Keyframe) -> { Instance }
    GetPoses: (self: Keyframe) -> { Instance }
    RemoveMarker: (self: Keyframe, marker: Instance) -> ()
    RemovePose: (self: Keyframe, pose: Instance) -> ()
end

declare class KeyframeMarker extends Instance
    Value: string
end

declare class KeyframeSequenceProvider extends Instance
    GetKeyframeSequence: (self: KeyframeSequenceProvider, assetId: string) -> Instance
    GetKeyframeSequenceById: (self: KeyframeSequenceProvider, assetId: number, useCache: boolean) -> Instance
    RegisterActiveKeyframeSequence: (self: KeyframeSequenceProvider, keyframeSequence: Instance) -> string
    RegisterKeyframeSequence: (self: KeyframeSequenceProvider, keyframeSequence: Instance) -> string
    GetAnimations: (self: KeyframeSequenceProvider, userId: number) -> Instance
    GetKeyframeSequenceAsync: (self: KeyframeSequenceProvider, assetId: string) -> Instance
end

declare class LSPFileSyncService extends Instance
end

declare class LanguageService extends Instance
end

declare class Light extends Instance
    Brightness: number
    Color: Color3
    Enabled: boolean
    Shadows: boolean
end

declare class PointLight extends Light
    Range: number
end

declare class SpotLight extends Light
    Angle: number
    Face: EnumItem
    Range: number
end

declare class SurfaceLight extends Light
    Angle: number
    Face: EnumItem
    Range: number
end

declare class Lighting extends Instance
    Ambient: Color3
    Brightness: number
    ClockTime: number
    ColorShift_Bottom: Color3
    ColorShift_Top: Color3
    EnvironmentDiffuseScale: number
    EnvironmentSpecularScale: number
    ExposureCompensation: number
    FogColor: Color3
    FogEnd: number
    FogStart: number
    GeographicLatitude: number
    GlobalShadows: boolean
    OutdoorAmbient: Color3
    Outlines: boolean
    ShadowColor: Color3
    ShadowSoftness: number
    TimeOfDay: string
    GetMinutesAfterMidnight: (self: Lighting) -> number
    GetMoonDirection: (self: Lighting) -> Vector3
    GetMoonPhase: (self: Lighting) -> number
    GetSunDirection: (self: Lighting) -> Vector3
    SetMinutesAfterMidnight: (self: Lighting, minutes: number) -> ()
    getMinutesAfterMidnight: (self: Lighting) -> number
    setMinutesAfterMidnight: (self: Lighting, minutes: number) -> ()
    LightingChanged: RBXScriptSignal
end

declare class LiveScriptingService extends Instance
end

declare class LocalStorageService extends Instance
end

declare class AppStorageService extends LocalStorageService
end

declare class UserStorageService extends LocalStorageService
end

declare class LocalizationService extends Instance
    RobloxLocaleId: string
    SystemLocaleId: string
    GetCorescriptLocalizations: (self: LocalizationService) -> { Instance }
    GetTableEntries: (self: LocalizationService, instance: Instance?) -> { any }
    GetTranslatorForPlayer: (self: LocalizationService, player: Instance) -> Instance
    GetCountryRegionForPlayerAsync: (self: LocalizationService, player: Instance) -> string
    GetTranslatorForLocaleAsync: (self: LocalizationService, locale: string) -> Instance
    GetTranslatorForPlayerAsync: (self: LocalizationService, player: Instance) -> Instance
end

declare class LocalizationTable extends Instance
    DevelopmentLanguage: string
    Root: Instance
    SourceLocaleId: string
    GetContents: (self: LocalizationTable) -> string
    GetEntries: (self: LocalizationTable) -> { any }
    GetString: (self: LocalizationTable, targetLocaleId: string, key: string) -> string
    GetTranslator: (self: LocalizationTable, localeId: string) -> Instance
    RemoveEntry: (self: LocalizationTable, key: string, source: string, context: string) -> ()
    RemoveEntryValue: (self: LocalizationTable, key: string, source: string, context: string, localeId: string) -> ()
    RemoveKey: (self: LocalizationTable, key: string) -> ()
    RemoveTargetLocale: (self: LocalizationTable, localeId: string) -> ()
    SetContents: (self: LocalizationTable, contents: string) -> ()
    SetEntries: (self: LocalizationTable, entries: any) -> ()
    SetEntry: (self: LocalizationTable, key: string, targetLocaleId: string, text: string) -> ()
    SetEntryContext: (self: LocalizationTable, key: string, source: string, context: string, newContext: string) -> ()
    SetEntryExample: (self: LocalizationTable, key: string, source: string, context: string, example: string) -> ()
    SetEntryKey: (self: LocalizationTable, key: string, source: string, context: string, newKey: string) -> ()
    SetEntrySource: (self: LocalizationTable, key: string, source: string, context: string, newSource: string) -> ()
    SetEntryValue: (self: LocalizationTable, key: string, source: string, context: string, localeId: string, text: string) -> ()
end

declare class CloudLocalizationTable extends LocalizationTable
end

declare class LodDataEntity extends Instance
    EntityLodEnabled: boolean
end

declare class LodDataService extends Instance
end

declare class LogService extends Instance
    ClearOutput: (self: LogService) -> ()
    GetLogHistory: (self: LogService) -> { any }
    MessageOut: RBXScriptSignal
end

declare class LoginService extends Instance
end

declare class LuaSettings extends Instance
end

declare class LuaSourceContainer extends Instance
    RuntimeSource: string
end

declare class BaseScript extends LuaSourceContainer
    Disabled: boolean
    Enabled: boolean
    LinkedSource: string
    RunContext: EnumItem
end

declare class CoreScript extends BaseScript
end

declare class Script extends BaseScript
    Source: ProtectedString
end

declare class LocalScript extends Script
end

declare class ModuleScript extends LuaSourceContainer
    LinkedSource: string
    Source: ProtectedString
end

declare class LuaWebService extends Instance
end

declare class LuauScriptAnalyzerService extends Instance
end

declare class MarkerCurve extends Instance
    Length: number
    GetMarkerAtIndex: (self: MarkerCurve, index: number) -> { [string]: any }
    GetMarkers: (self: MarkerCurve) -> { any }
    InsertMarkerAtTime: (self: MarkerCurve, time: number, marker: string) -> { any }
    RemoveMarkerAtIndex: (self: MarkerCurve, startingIndex: number, count: number?) -> number
end

declare class MarketplaceService extends Instance
    PromptBundlePurchase: (self: MarketplaceService, player: Instance, bundleId: number) -> ()
    PromptGamePassPurchase: (self: MarketplaceService, player: Instance, gamePassId: number) -> ()
    PromptPremiumPurchase: (self: MarketplaceService, player: Instance) -> ()
    PromptProductPurchase: (self: MarketplaceService, player: Instance, productId: number, equipIfPurchased: boolean?, currencyType: EnumItem?) -> ()
    PromptPurchase: (self: MarketplaceService, player: Instance, assetId: number, equipIfPurchased: boolean?, currencyType: EnumItem?) -> ()
    PromptSubscriptionCancellation: (self: MarketplaceService, player: Instance, subscriptionId: number) -> ()
    PromptSubscriptionPurchase: (self: MarketplaceService, player: Instance, subscriptionId: number) -> ()
    GetDeveloperProductsAsync: (self: MarketplaceService) -> Instance
    GetProductInfo: (self: MarketplaceService, assetId: number, infoType: EnumItem?) -> { [string]: any }
    IsPlayerSubscribed: (self: MarketplaceService, player: Instance, subscriptionId: number) -> boolean
    PlayerOwnsAsset: (self: MarketplaceService, player: Instance, assetId: number) -> boolean
    PlayerOwnsBundle: (self: MarketplaceService, player: Player, bundleId: number) -> boolean
    UserOwnsGamePassAsync: (self: MarketplaceService, userId: number, gamePassId: number) -> boolean
    PromptBundlePurchaseFinished: RBXScriptSignal
    PromptGamePassPurchaseFinished: RBXScriptSignal
    PromptPremiumPurchaseFinished: RBXScriptSignal
    PromptProductPurchaseFinished: RBXScriptSignal
    PromptPurchaseFinished: RBXScriptSignal
    PromptSubscriptionCancellationFinished: RBXScriptSignal
    PromptSubscriptionPurchaseFinished: RBXScriptSignal
    ProcessReceipt: (receiptInfo: { [string]: any }) -> EnumItem?
end

declare class MaterialGenerationService extends Instance
end

declare class MaterialGenerationSession extends Instance
end

declare class MaterialService extends Instance
    GetBaseMaterialOverride: (self: MaterialService, material: EnumItem) -> string
    GetMaterialVariant: (self: MaterialService, material: EnumItem, name: string) -> MaterialVariant
    SetBaseMaterialOverride: (self: MaterialService, material: EnumItem, name: string) -> ()
end

declare class MaterialVariant extends Instance
    BaseMaterial: EnumItem
    ColorMap: string
    CustomPhysicalProperties: PhysicalProperties
    MaterialPattern: EnumItem
    MetalnessMap: string
    NormalMap: string
    RoughnessMap: string
    StudsPerTile: number
end

declare class MemStorageConnection extends Instance
    Disconnect: (self: MemStorageConnection) -> ()
end

declare class MemStorageService extends Instance
end

declare class MemoryStoreQueue extends Instance
    AddAsync: (self: MemoryStoreQueue, value: any, expiration: number, priority: number?) -> ()
    ReadAsync: (self: MemoryStoreQueue, count: number, allOrNothing: boolean?, waitTimeout: number?) -> ...any
    RemoveAsync: (self: MemoryStoreQueue, id: string) -> ()
end

declare class MemoryStoreService extends Instance
    GetQueue: (self: MemoryStoreService, name: string, invisibilityTimeout: number?) -> MemoryStoreQueue
    GetSortedMap: (self: MemoryStoreService, name: string) -> MemoryStoreSortedMap
end

declare class MemoryStoreSortedMap extends Instance
    GetAsync: (self: MemoryStoreSortedMap, key: string) -> any
    GetRangeAsync: (self: MemoryStoreSortedMap, direction: EnumItem, count: number, exclusiveLowerBound: string?, exclusiveUpperBound: string?) -> { any }
    RemoveAsync: (self: MemoryStoreSortedMap, key: string) -> ()
    SetAsync: (self: MemoryStoreSortedMap, key: string, value: any, expiration: number) -> boolean
    UpdateAsync: (self: MemoryStoreSortedMap, key: string, transformFunction: (...any) -> ...any, expiration: number) -> any
end

declare class Message extends Instance
    Text: string
end

declare class Hint extends Message
end

declare class MessageBusConnection extends Instance
end

declare class MessageBusService extends Instance
end

declare class MessagingService extends Instance
    PublishAsync: (self: MessagingService, topic: string, message: any) -> ()
    SubscribeAsync: (self: MessagingService, topic: string, callback: (...any) -> ...any) -> RBXScriptConnection
end

declare class MetaBreakpoint extends Instance
end

declare class MetaBreakpointContext extends Instance
end

declare class MetaBreakpointManager extends Instance
end

declare class Mouse extends Instance
    Hit: CFrame
    Icon: string
    Origin: CFrame
    Target: BasePart
    TargetFilter: Instance
    TargetSurface: EnumItem
    UnitRay: Ray
    ViewSizeX: number
    ViewSizeY: number
    X: number
    Y: number
    hit: CFrame
    target: BasePart
    Button1Down: RBXScriptSignal
    Button1Up: RBXScriptSignal
    Button2Down: RBXScriptSignal
    Button2Up: RBXScriptSignal
    Idle: RBXScriptSignal
    KeyDown: RBXScriptSignal
    KeyUp: RBXScriptSignal
    Move: RBXScriptSignal
    WheelBackward: RBXScriptSignal
    WheelForward: RBXScriptSignal
    keyDown: RBXScriptSignal
end

declare class PlayerMouse extends Mouse
end

declare class PluginMouse extends Mouse
    DragEnter: RBXScriptSignal
end

declare class MouseService extends Instance
end

declare class MultipleDocumentInterfaceInstance extends Instance
end

declare class NetworkMarker extends Instance
    Received: RBXScriptSignal
end

declare class NetworkPeer extends Instance
    SetOutgoingKBPSLimit: (self: NetworkPeer, limit: number) -> ()
end

declare class NetworkClient extends NetworkPeer
    ConnectionAccepted: RBXScriptSignal
    ConnectionFailed: RBXScriptSignal
end

declare class NetworkServer extends NetworkPeer
    EncryptStringForPlayerId: (self: NetworkServer, toEncrypt: string, playerId: number) -> string
end

declare class NetworkReplicator extends Instance
    GetPlayer: (self: NetworkReplicator) -> Instance
end

declare class ClientReplicator extends NetworkReplicator
end

declare class ServerReplicator extends NetworkReplicator
end

declare class NetworkSettings extends Instance
    EmulatedTotalMemoryInMB: number
    FreeMemoryMBytes: number
    HttpProxyEnabled: boolean
    HttpProxyURL: string
    IncomingReplicationLag: number
    PrintJoinSizeBreakdown: boolean
    PrintPhysicsErrors: boolean
    PrintStreamInstanceQuota: boolean
    RandomizeJoinInstanceOrder: boolean
    RenderStreamedRegions: boolean
    ShowActiveAnimationAsset: boolean
end

declare class NoCollisionConstraint extends Instance
    Enabled: boolean
    Part0: BasePart
    Part1: BasePart
end

declare class NotificationService extends Instance
    Roblox17sConnectionChanged: RBXScriptSignal
    Roblox17sEventReceived: RBXScriptSignal
end

declare class OmniRecommendationsService extends Instance
end

declare class OpenCloudApiV1 extends Instance
    CreateModel: (self: OpenCloudApiV1, name: string) -> OpenCloudModel
    CreateUserNotificationAsync: (self: OpenCloudApiV1, user: string, userNotification: OpenCloudModel) -> OpenCloudModel
end

declare class OpenCloudService extends Instance
    GetApiV1: (self: OpenCloudService) -> OpenCloudApiV1
end

declare class PVInstance extends Instance
    GetPivot: (self: PVInstance) -> CFrame
    PivotTo: (self: PVInstance, targetCFrame: CFrame) -> ()
end

declare class BasePart extends PVInstance
    Anchored: boolean
    AssemblyAngularVelocity: Vector3
    AssemblyCenterOfMass: Vector3
    AssemblyLinearVelocity: Vector3
    AssemblyMass: number
    AssemblyRootPart: BasePart
    BackParamA: number
    BackParamB: number
    BackSurface: EnumItem
    BackSurfaceInput: EnumItem
    BottomParamA: number
    BottomParamB: number
    BottomSurface: EnumItem
    BottomSurfaceInput: EnumItem
    BrickColor: BrickColor
    CFrame: CFrame
    CanCollide: boolean
    CanQuery: boolean
    CanTouch: boolean
    CastShadow: boolean
    CenterOfMass: Vector3
    CollisionGroup: string
    CollisionGroupId: number
    Color: Color3
    CurrentPhysicalProperties: PhysicalProperties
    CustomPhysicalProperties: PhysicalProperties
    Elasticity: number
    EnableFluidForces: boolean
    ExtentsCFrame: CFrame
    ExtentsSize: Vector3
    Friction: number
    FrontParamA: number
    FrontParamB: number
    FrontSurface: EnumItem
    FrontSurfaceInput: EnumItem
    LeftParamA: number
    LeftParamB: number
    LeftSurface: EnumItem
    LeftSurfaceInput: EnumItem
    LocalTransparencyModifier: number
    Locked: boolean
    Mass: number
    Massless: boolean
    Material: EnumItem
    MaterialVariant: string
    Orientation: Vector3
    PivotOffset: CFrame
    Position: Vector3
    ReceiveAge: number
    Reflectance: number
    ResizeIncrement: number
    ResizeableFaces: Faces
    RightParamA: number
    RightParamB: number
    RightSurface: EnumItem
    RightSurfaceInput: EnumItem
    RootPriority: number
    RotVelocity: Vector3
    Rotation: Vector3
    Size: Vector3
    SpecificGravity: number
    TopParamA: number
    TopParamB: number
    TopSurface: EnumItem
    TopSurfaceInput: EnumItem
    Transparency: number
    Velocity: Vector3
    brickColor: BrickColor
    ApplyAngularImpulse: (self: BasePart, impulse: Vector3) -> ()
    ApplyImpulse: (self: BasePart, impulse: Vector3) -> ()
    ApplyImpulseAtPosition: (self: BasePart, impulse: Vector3, position: Vector3) -> ()
    BreakJoints: (self: BasePart) -> ()
    CanCollideWith: (self: BasePart, part: BasePart) -> boolean
    CanSetNetworkOwnership: (self: BasePart) -> ...any
    GetClosestPointOnSurface: (self: BasePart, position: Vector3) -> Vector3
    GetConnectedParts: (self: BasePart, recursive: boolean?) -> { Instance }
    GetJoints: (self: BasePart) -> { Instance }
    GetMass: (self: BasePart) -> number
    GetNetworkOwner: (self: BasePart) -> Instance
    GetNetworkOwnershipAuto: (self: BasePart) -> boolean
    GetNoCollisionConstraints: (self: BasePart) -> { Instance }
    GetRenderCFrame: (self: BasePart) -> CFrame
    GetRootPart: (self: BasePart) -> Instance
    GetTouchingParts: (self: BasePart) -> { Instance }
    GetVelocityAtPosition: (self: BasePart, position: Vector3) -> Vector3
    IsGrounded: (self: BasePart) -> boolean
    MakeJoints: (self: BasePart) -> ()
    Resize: (self: BasePart, normalId: EnumItem, deltaAmount: number) -> boolean
    SetNetworkOwner: (self: BasePart, playerInstance: Player?) -> ()
    SetNetworkOwnershipAuto: (self: BasePart) -> ()
    breakJoints: (self: BasePart) -> ()
    getMass: (self: BasePart) -> number
    makeJoints: (self: BasePart) -> ()
    resize: (self: BasePart, normalId: EnumItem, deltaAmount: number) -> boolean
    IntersectAsync: (self: BasePart, parts: { Instance }, collisionfidelity: EnumItem?, renderFidelity: EnumItem?) -> Instance
    SubtractAsync: (self: BasePart, parts: { Instance }, collisionfidelity: EnumItem?, renderFidelity: EnumItem?) -> Instance
    UnionAsync: (self: BasePart, parts: { Instance }, collisionfidelity: EnumItem?, renderFidelity: EnumItem?) -> Instance
    LocalSimulationTouched: RBXScriptSignal
    OutfitChanged: RBXScriptSignal
    StoppedTouching: RBXScriptSignal
    TouchEnded: RBXScriptSignal
    Touched: RBXScriptSignal
end

declare class CornerWedgePart extends BasePart
end

declare class FormFactorPart extends BasePart
    FormFactor: EnumItem
    formFactor: EnumItem
end

declare class Part extends FormFactorPart
    Shape: EnumItem
end

declare class FlagStand extends Part
    TeamColor: BrickColor
    FlagCaptured: RBXScriptSignal
end

declare class Platform extends Part
end

declare class Seat extends Part
    Disabled: boolean
    Occupant: Humanoid
    Sit: (self: Seat, humanoid: Instance) -> ()
end

declare class SkateboardPlatform extends Part
    Controller: SkateboardController
    ControllingHumanoid: Humanoid
    Steer: number
    StickyWheels: boolean
    Throttle: number
    ApplySpecificImpulse: (self: SkateboardPlatform, impulseWorld: Vector3) -> ()
    Equipped: RBXScriptSignal
    MoveStateChanged: RBXScriptSignal
    Unequipped: RBXScriptSignal
    equipped: RBXScriptSignal
    unequipped: RBXScriptSignal
end

declare class SpawnLocation extends Part
    AllowTeamChangeOnTouch: boolean
    Duration: number
    Enabled: boolean
    Neutral: boolean
    TeamColor: BrickColor
end

declare class WedgePart extends FormFactorPart
end

declare class Terrain extends BasePart
    IsSmooth: boolean
    MaxExtents: Region3int16
    WaterColor: Color3
    WaterReflectance: number
    WaterTransparency: number
    WaterWaveSize: number
    WaterWaveSpeed: number
    AutowedgeCell: (self: Terrain, x: number, y: number, z: number) -> boolean
    AutowedgeCells: (self: Terrain, region: Region3int16) -> ()
    CellCenterToWorld: (self: Terrain, x: number, y: number, z: number) -> Vector3
    CellCornerToWorld: (self: Terrain, x: number, y: number, z: number) -> Vector3
    Clear: (self: Terrain) -> ()
    ConvertToSmooth: (self: Terrain) -> ()
    CopyRegion: (self: Terrain, region: Region3int16) -> TerrainRegion
    CountCells: (self: Terrain) -> number
    FillBall: (self: Terrain, center: Vector3, radius: number, material: EnumItem) -> ()
    FillBlock: (self: Terrain, cframe: CFrame, size: Vector3, material: EnumItem) -> ()
    FillCylinder: (self: Terrain, cframe: CFrame, height: number, radius: number, material: EnumItem) -> ()
    FillRegion: (self: Terrain, region: Region3, resolution: number, material: EnumItem) -> ()
    FillWedge: (self: Terrain, cframe: CFrame, size: Vector3, material: EnumItem) -> ()
    GetCell: (self: Terrain, x: number, y: number, z: number) -> ...any
    GetMaterialColor: (self: Terrain, material: EnumItem) -> Color3
    GetWaterCell: (self: Terrain, x: number, y: number, z: number) -> ...any
    PasteRegion: (self: Terrain, region: TerrainRegion, corner: Vector3int16, pasteEmptyCells: boolean) -> ()
    ReadVoxels: (self: Terrain, region: Region3, resolution: number) -> ...any
    ReplaceMaterial: (self: Terrain, region: Region3, resolution: number, sourceMaterial: EnumItem, targetMaterial: EnumItem) -> ()
    SetCell: (self: Terrain, x: number, y: number, z: number, material: EnumItem, block: EnumItem, orientation: EnumItem) -> ()
    SetCells: (self: Terrain, region: Region3int16, material: EnumItem, block: EnumItem, orientation: EnumItem) -> ()
    SetMaterialColor: (self: Terrain, material: EnumItem, value: Color3) -> ()
    SetWaterCell: (self: Terrain, x: number, y: number, z: number, force: EnumItem, direction: EnumItem) -> ()
    WorldToCell: (self: Terrain, position: Vector3) -> Vector3
    WorldToCellPreferEmpty: (self: Terrain, position: Vector3) -> Vector3
    WorldToCellPreferSolid: (self: Terrain, position: Vector3) -> Vector3
    WriteVoxels: (self: Terrain, region: Region3, resolution: number, materials: { any }, occupancy: { any }) -> ()
end

declare class TriangleMeshPart extends BasePart
    CollisionFidelity: EnumItem
    MeshSize: Vector3
end

declare class MeshPart extends TriangleMeshPart
    DoubleSided: boolean
    HasJointOffset: boolean
    HasSkinnedMesh: boolean
    JointOffset: Vector3
    MeshId: string
    RenderFidelity: EnumItem
    TextureID: string
    ApplyMesh: (self: MeshPart, meshPart: Instance) -> ()
end

declare class PartOperation extends TriangleMeshPart
    RenderFidelity: EnumItem
    SmoothingAngle: number
    TriangleCount: number
    UsePartColor: boolean
    SubstituteGeometry: (self: PartOperation, source: Instance) -> ()
end

declare class IntersectOperation extends PartOperation
end

declare class NegateOperation extends PartOperation
end

declare class UnionOperation extends PartOperation
end

declare class TrussPart extends BasePart
    Style: EnumItem
end

declare class VehicleSeat extends BasePart
    AreHingesDetected: number
    Disabled: boolean
    HeadsUpDisplay: boolean
    MaxSpeed: number
    Occupant: Humanoid
    Steer: number
    SteerFloat: number
    Throttle: number
    ThrottleFloat: number
    Torque: number
    TurnSpeed: number
    Sit: (self: VehicleSeat, humanoid: Instance) -> ()
end

declare class Model extends PVInstance
    LevelOfDetail: EnumItem
    ModelStreamingMode: EnumItem
    PrimaryPart: BasePart
    WorldPivot: CFrame
    AddPersistentPlayer: (self: Model, playerInstance: Player?) -> ()
    BreakJoints: (self: Model) -> ()
    GetBoundingBox: (self: Model) -> ...any
    GetExtentsSize: (self: Model) -> Vector3
    GetModelCFrame: (self: Model) -> CFrame
    GetModelSize: (self: Model) -> Vector3
    GetPersistentPlayers: (self: Model) -> { Instance }
    GetPrimaryPartCFrame: (self: Model) -> CFrame
    GetScale: (self: Model) -> number
    MakeJoints: (self: Model) -> ()
    MoveTo: (self: Model, position: Vector3) -> ()
    RemovePersistentPlayer: (self: Model, playerInstance: Player?) -> ()
    ResetOrientationToIdentity: (self: Model) -> ()
    ScaleTo: (self: Model, newScaleFactor: number) -> ()
    SetIdentityOrientation: (self: Model) -> ()
    SetPrimaryPartCFrame: (self: Model, cframe: CFrame) -> ()
    TranslateBy: (self: Model, delta: Vector3) -> ()
    breakJoints: (self: Model) -> ()
    makeJoints: (self: Model) -> ()
    move: (self: Model, location: Vector3) -> ()
    moveTo: (self: Model, location: Vector3) -> ()
end

declare class Actor extends Model
    BindToMessage: (self: Actor, topic: string, _function: (...any) -> ...any) -> RBXScriptConnection
    BindToMessageParallel: (self: Actor, topic: string, _function: (...any) -> ...any) -> RBXScriptConnection
    SendMessage: (self: Actor, topic: string, ...any) -> ()
end

declare class BackpackItem extends Model
    TextureId: string
end

declare class HopperBin extends BackpackItem
    Active: boolean
    BinType: EnumItem
    Deselected: RBXScriptSignal
    Selected: RBXScriptSignal
end

declare class Tool extends BackpackItem
    CanBeDropped: boolean
    Enabled: boolean
    Grip: CFrame
    GripForward: Vector3
    GripPos: Vector3
    GripRight: Vector3
    GripUp: Vector3
    ManualActivationOnly: boolean
    RequiresHandle: boolean
    ToolTip: string
    Activate: (self: Tool) -> ()
    Deactivate: (self: Tool) -> ()
    Activated: RBXScriptSignal
    Deactivated: RBXScriptSignal
    Equipped: RBXScriptSignal
    Unequipped: RBXScriptSignal
end

declare class Flag extends Tool
    TeamColor: BrickColor
end

declare class Status extends Model
end

declare class WorldRoot extends Model
    ArePartsTouchingOthers: (self: WorldRoot, partList: { Instance }, overlapIgnored: number?) -> boolean
    Blockcast: (self: WorldRoot, cframe: CFrame, size: Vector3, direction: Vector3, params: RaycastParams?) -> RaycastResult
    BulkMoveTo: (self: WorldRoot, partList: { Instance }, cframeList: { any }, eventMode: EnumItem?) -> ()
    FindPartOnRay: (self: WorldRoot, ray: Ray, ignoreDescendantsInstance: Instance?, terrainCellsAreCubes: boolean?, ignoreWater: boolean?) -> ...any
    FindPartOnRayWithIgnoreList: (self: WorldRoot, ray: Ray, ignoreDescendantsTable: { Instance }, terrainCellsAreCubes: boolean?, ignoreWater: boolean?) -> ...any
    FindPartOnRayWithWhitelist: (self: WorldRoot, ray: Ray, whitelistDescendantsTable: { Instance }, ignoreWater: boolean?) -> ...any
    FindPartsInRegion3: (self: WorldRoot, region: Region3, ignoreDescendantsInstance: Instance?, maxParts: number?) -> { Instance }
    FindPartsInRegion3WithIgnoreList: (self: WorldRoot, region: Region3, ignoreDescendantsTable: { Instance }, maxParts: number?) -> { Instance }
    FindPartsInRegion3WithWhiteList: (self: WorldRoot, region: Region3, whitelistDescendantsTable: { Instance }, maxParts: number?) -> { Instance }
    GetPartBoundsInBox: (self: WorldRoot, cframe: CFrame, size: Vector3, overlapParams: OverlapParams?) -> { Instance }
    GetPartBoundsInRadius: (self: WorldRoot, position: Vector3, radius: number, overlapParams: OverlapParams?) -> { Instance }
    GetPartsInPart: (self: WorldRoot, part: BasePart, overlapParams: OverlapParams?) -> { Instance }
    IKMoveTo: (self: WorldRoot, part: BasePart, target: CFrame, translateStiffness: number?, rotateStiffness: number?, collisionsMode: EnumItem?) -> ()
    IsRegion3Empty: (self: WorldRoot, region: Region3, ignoreDescendentsInstance: Instance?) -> boolean
    IsRegion3EmptyWithIgnoreList: (self: WorldRoot, region: Region3, ignoreDescendentsTable: { Instance }) -> boolean
    Raycast: (self: WorldRoot, origin: Vector3, direction: Vector3, raycastParams: RaycastParams?) -> RaycastResult
    Spherecast: (self: WorldRoot, position: Vector3, radius: number, direction: Vector3, params: RaycastParams?) -> RaycastResult
    findPartOnRay: (self: WorldRoot, ray: Ray, ignoreDescendantsInstance: Instance?, terrainCellsAreCubes: boolean?, ignoreWater: boolean?) -> ...any
    findPartsInRegion3: (self: WorldRoot, region: Region3, ignoreDescendantsInstance: Instance?, maxParts: number?) -> { Instance }
end

declare class Workspace extends WorldRoot
    AirDensity: number
    AllowThirdPartySales: boolean
    ClientAnimatorThrottling: EnumItem
    CurrentCamera: Camera
    DistributedGameTime: number
    FallenPartsDestroyHeight: number
    FilteringEnabled: boolean
    GlobalWind: Vector3
    Gravity: number
    InterpolationThrottling: EnumItem
    Retargeting: EnumItem
    StreamingEnabled: boolean
    Terrain: Terrain
    BreakJoints: (self: Workspace, objects: { Instance }) -> ()
    GetNumAwakeParts: (self: Workspace) -> number
    GetPhysicsThrottling: (self: Workspace) -> number
    GetRealPhysicsFPS: (self: Workspace) -> number
    GetServerTimeNow: (self: Workspace) -> number
    JoinToOutsiders: (self: Workspace, objects: { Instance }, jointType: EnumItem) -> ()
    MakeJoints: (self: Workspace, objects: { Instance }) -> ()
    PGSIsEnabled: (self: Workspace) -> boolean
    UnjoinFromOutsiders: (self: Workspace, objects: { Instance }) -> ()
    ZoomToExtents: (self: Workspace) -> ()
    PersistentLoaded: RBXScriptSignal
end

declare class WorldModel extends WorldRoot
end

declare class PackageLink extends Instance
    PackageId: string
    VersionNumber: number
end

declare class PackageService extends Instance
end

declare class PackageUIService extends Instance
end

declare class Pages extends Instance
    IsFinished: boolean
    GetCurrentPage: (self: Pages) -> { any }
    AdvanceToNextPageAsync: (self: Pages) -> ()
end

declare class AudioPages extends Pages
end

declare class CatalogPages extends Pages
end

declare class DataStoreKeyPages extends Pages
    Cursor: string
end

declare class DataStoreListingPages extends Pages
    Cursor: string
end

declare class DataStorePages extends Pages
end

declare class DataStoreVersionPages extends Pages
end

declare class FriendPages extends Pages
end

declare class InventoryPages extends Pages
end

declare class EmotesPages extends InventoryPages
end

declare class OutfitPages extends Pages
end

declare class StandardPages extends Pages
end

declare class PartOperationAsset extends Instance
end

declare class ParticleEmitter extends Instance
    Acceleration: Vector3
    Brightness: number
    Color: ColorSequence
    Drag: number
    EmissionDirection: EnumItem
    Enabled: boolean
    FlipbookFramerate: NumberRange
    FlipbookIncompatible: string
    FlipbookLayout: EnumItem
    FlipbookMode: EnumItem
    FlipbookStartRandom: boolean
    Lifetime: NumberRange
    LightEmission: number
    LightInfluence: number
    LockedToPart: boolean
    Orientation: EnumItem
    Rate: number
    RotSpeed: NumberRange
    Rotation: NumberRange
    Shape: EnumItem
    ShapeInOut: EnumItem
    ShapePartial: number
    ShapeStyle: EnumItem
    Size: NumberSequence
    Speed: NumberRange
    SpreadAngle: Vector2
    Squash: NumberSequence
    Texture: string
    TimeScale: number
    Transparency: NumberSequence
    VelocityInheritance: number
    VelocitySpread: number
    WindAffectsDrag: boolean
    ZOffset: number
    Clear: (self: ParticleEmitter) -> ()
    Emit: (self: ParticleEmitter, particleCount: number?) -> ()
end

declare class PatchBundlerFileWatch extends Instance
end

declare class PatchMapping extends Instance
    FlattenTree: boolean
    PatchId: string
    TargetPath: string
end

declare class Path extends Instance
    Status: EnumItem
    GetPointCoordinates: (self: Path) -> { any }
    GetWaypoints: (self: Path) -> { any }
    CheckOcclusionAsync: (self: Path, start: number) -> number
    ComputeAsync: (self: Path, start: Vector3, finish: Vector3) -> ()
    Blocked: RBXScriptSignal
    Unblocked: RBXScriptSignal
end

declare class PathfindingLink extends Instance
    Attachment0: Attachment
    Attachment1: Attachment
    IsBidirectional: boolean
    Label: string
end

declare class PathfindingModifier extends Instance
    Label: string
    PassThrough: boolean
end

declare class PathfindingService extends Instance
    EmptyCutoff: number
    CreatePath: (self: PathfindingService, agentParameters: { [string]: any }?) -> Instance
    ComputeRawPathAsync: (self: PathfindingService, start: Vector3, finish: Vector3, maxDistance: number) -> Instance
    ComputeSmoothPathAsync: (self: PathfindingService, start: Vector3, finish: Vector3, maxDistance: number) -> Instance
    FindPathAsync: (self: PathfindingService, start: Vector3, finish: Vector3) -> Instance
end

declare class PausedState extends Instance
end

declare class PausedStateBreakpoint extends PausedState
end

declare class PausedStateException extends PausedState
end

declare class PermissionsService extends Instance
end

declare class PhysicsService extends Instance
    CollisionGroupContainsPart: (self: PhysicsService, name: string, part: BasePart) -> boolean
    CollisionGroupSetCollidable: (self: PhysicsService, name1: string, name2: string, collidable: boolean) -> ()
    CollisionGroupsAreCollidable: (self: PhysicsService, name1: string, name2: string) -> boolean
    CreateCollisionGroup: (self: PhysicsService, name: string) -> number
    GetCollisionGroupId: (self: PhysicsService, name: string) -> number
    GetCollisionGroupName: (self: PhysicsService, name: number) -> string
    GetCollisionGroups: (self: PhysicsService) -> { any }
    GetMaxCollisionGroups: (self: PhysicsService) -> number
    GetRegisteredCollisionGroups: (self: PhysicsService) -> { any }
    IsCollisionGroupRegistered: (self: PhysicsService, name: string) -> boolean
    RegisterCollisionGroup: (self: PhysicsService, name: string) -> ()
    RemoveCollisionGroup: (self: PhysicsService, name: string) -> ()
    RenameCollisionGroup: (self: PhysicsService, from: string, to: string) -> ()
    SetPartCollisionGroup: (self: PhysicsService, part: BasePart, name: string) -> ()
    UnregisterCollisionGroup: (self: PhysicsService, name: string) -> ()
end

declare class PhysicsSettings extends Instance
    AllowSleep: boolean
    AreAnchorsShown: boolean
    AreAssembliesShown: boolean
    AreAwakePartsHighlighted: boolean
    AreBodyTypesShown: boolean
    AreContactIslandsShown: boolean
    AreContactPointsShown: boolean
    AreJointCoordinatesShown: boolean
    AreMechanismsShown: boolean
    AreModelCoordsShown: boolean
    AreOwnersShown: boolean
    ArePartCoordsShown: boolean
    AreRegionsShown: boolean
    AreTerrainReplicationRegionsShown: boolean
    AreUnalignedPartsShown: boolean
    AreWorldCoordsShown: boolean
    DisableCSGv2: boolean
    DisableCSGv3ForPlugins: boolean
    ForceCSGv2: boolean
    IsInterpolationThrottleShown: boolean
    IsReceiveAgeShown: boolean
    IsTreeShown: boolean
    PhysicsEnvironmentalThrottle: EnumItem
    ShowDecompositionGeometry: boolean
    ThrottleAdjustTime: number
    UseCSGv2: boolean
end

declare class PlaceStatsService extends Instance
end

declare class PlacesService extends Instance
end

declare class Player extends Instance
    AccountAge: number
    AutoJumpEnabled: boolean
    CameraMaxZoomDistance: number
    CameraMinZoomDistance: number
    CameraMode: EnumItem
    CanLoadCharacterAppearance: boolean
    Character: Model
    CharacterAppearance: string
    CharacterAppearanceId: number
    DataComplexity: number
    DataReady: boolean
    DevCameraOcclusionMode: EnumItem
    DevComputerCameraMode: EnumItem
    DevComputerMovementMode: EnumItem
    DevEnableMouseLock: boolean
    DevTouchCameraMode: EnumItem
    DevTouchMovementMode: EnumItem
    DisplayName: string
    FollowUserId: number
    GameplayPaused: boolean
    HasVerifiedBadge: boolean
    HealthDisplayDistance: number
    LocaleId: string
    MembershipType: EnumItem
    NameDisplayDistance: number
    Neutral: boolean
    ReplicationFocus: Instance
    RespawnLocation: SpawnLocation
    Team: Team
    TeamColor: BrickColor
    UserId: number
    userId: number
    ClearCharacterAppearance: (self: Player) -> ()
    DistanceFromCharacter: (self: Player, point: Vector3) -> number
    GetJoinData: (self: Player) -> { [string]: any }
    GetMouse: (self: Player) -> Mouse
    GetNetworkPing: (self: Player) -> number
    HasAppearanceLoaded: (self: Player) -> boolean
    IsVerified: (self: Player) -> boolean
    Kick: (self: Player, message: string?) -> ()
    LoadBoolean: (self: Player, key: string) -> boolean
    LoadCharacterAppearance: (self: Player, assetInstance: Instance) -> ()
    LoadInstance: (self: Player, key: string) -> Instance
    LoadNumber: (self: Player, key: string) -> number
    LoadString: (self: Player, key: string) -> string
    Move: (self: Player, walkDirection: Vector3, relativeToCamera: boolean?) -> ()
    SaveBoolean: (self: Player, key: string, value: boolean) -> ()
    SaveInstance: (self: Player, key: string, value: Instance) -> ()
    SaveNumber: (self: Player, key: string, value: number) -> ()
    SaveString: (self: Player, key: string, value: string) -> ()
    SetAccountAge: (self: Player, accountAge: number) -> ()
    SetSuperSafeChat: (self: Player, value: boolean) -> ()
    loadBoolean: (self: Player, key: string) -> boolean
    loadInstance: (self: Player, key: string) -> Instance
    loadNumber: (self: Player, key: string) -> number
    loadString: (self: Player, key: string) -> string
    saveBoolean: (self: Player, key: string, value: boolean) -> ()
    saveInstance: (self: Player, key: string, value: Instance) -> ()
    saveNumber: (self: Player, key: string, value: number) -> ()
    saveString: (self: Player, key: string, value: string) -> ()
    GetFriendsOnline: (self: Player, maxFriends: number?) -> { any }
    GetRankInGroup: (self: Player, groupId: number) -> number
    GetRoleInGroup: (self: Player, groupId: number) -> string
    IsBestFriendsWith: (self: Player, userId: number) -> boolean
    IsFriendsWith: (self: Player, userId: number) -> boolean
    IsInGroup: (self: Player, groupId: number) -> boolean
    LoadCharacter: (self: Player) -> ()
    LoadCharacterWithHumanoidDescription: (self: Player, humanoidDescription: HumanoidDescription) -> ()
    RequestStreamAroundAsync: (self: Player, position: Vector3, timeOut: number?) -> ()
    WaitForDataReady: (self: Player) -> boolean
    isFriendsWith: (self: Player, userId: number) -> boolean
    waitForDataReady: (self: Player) -> boolean
    CharacterAdded: RBXScriptSignal
    CharacterAppearanceLoaded: RBXScriptSignal
    CharacterRemoving: RBXScriptSignal
    Chatted: RBXScriptSignal
    Idled: RBXScriptSignal
    OnTeleport: RBXScriptSignal
end

declare class PlayerEmulatorService extends Instance
end

declare class PlayerScripts extends Instance
    ClearComputerCameraMovementModes: (self: PlayerScripts) -> ()
    ClearComputerMovementModes: (self: PlayerScripts) -> ()
    ClearTouchCameraMovementModes: (self: PlayerScripts) -> ()
    ClearTouchMovementModes: (self: PlayerScripts) -> ()
    RegisterComputerCameraMovementMode: (self: PlayerScripts, cameraMovementMode: EnumItem) -> ()
    RegisterComputerMovementMode: (self: PlayerScripts, movementMode: EnumItem) -> ()
    RegisterTouchCameraMovementMode: (self: PlayerScripts, cameraMovementMode: EnumItem) -> ()
    RegisterTouchMovementMode: (self: PlayerScripts, movementMode: EnumItem) -> ()
end

declare class Players extends Instance
    BubbleChat: boolean
    CharacterAutoLoads: boolean
    ClassicChat: boolean
    LocalPlayer: Player
    MaxPlayers: number
    NumPlayers: number
    PreferredPlayers: number
    RespawnTime: number
    localPlayer: Player
    numPlayers: number
    Chat: (self: Players, message: string) -> ()
    GetPlayerByUserId: (self: Players, userId: number) -> Player
    GetPlayerFromCharacter: (self: Players, character: Model?) -> Player
    GetPlayers: (self: Players) -> { Instance }
    SetChatStyle: (self: Players, style: EnumItem?) -> ()
    TeamChat: (self: Players, message: string) -> ()
    getPlayers: (self: Players) -> { Instance }
    playerFromCharacter: (self: Players, character: Model) -> Player
    players: (self: Players) -> { Instance }
    CreateHumanoidModelFromDescription: (self: Players, description: HumanoidDescription, rigType: EnumItem, assetTypeVerification: EnumItem?) -> Model
    CreateHumanoidModelFromUserId: (self: Players, userId: number) -> Model
    GetCharacterAppearanceAsync: (self: Players, userId: number) -> Model
    GetCharacterAppearanceInfoAsync: (self: Players, userId: number) -> { [string]: any }
    GetFriendsAsync: (self: Players, userId: number) -> FriendPages
    GetHumanoidDescriptionFromOutfitId: (self: Players, outfitId: number) -> HumanoidDescription
    GetHumanoidDescriptionFromUserId: (self: Players, userId: number) -> HumanoidDescription
    GetNameFromUserIdAsync: (self: Players, userId: number) -> string
    GetUserIdFromNameAsync: (self: Players, userName: string) -> number
    GetUserThumbnailAsync: (self: Players, userId: number, thumbnailType: EnumItem, thumbnailSize: EnumItem) -> ...any
    PlayerAdded: RBXScriptSignal
    PlayerMembershipChanged: RBXScriptSignal
    PlayerRemoving: RBXScriptSignal
end

declare class Plugin extends Instance
    CollisionEnabled: boolean
    GridSize: number
    Activate: (self: Plugin, exclusiveMouse: boolean) -> ()
    CreatePluginAction: (self: Plugin, actionId: string, text: string, statusTip: string, iconName: string?, allowBinding: boolean?) -> PluginAction
    CreatePluginMenu: (self: Plugin, id: string, title: string?, icon: string?) -> PluginMenu
    CreateToolbar: (self: Plugin, name: string) -> PluginToolbar
    Deactivate: (self: Plugin) -> ()
    GetJoinMode: (self: Plugin) -> EnumItem
    GetMouse: (self: Plugin) -> PluginMouse
    GetSelectedRibbonTool: (self: Plugin) -> EnumItem
    GetSetting: (self: Plugin, key: string) -> any
    GetStudioUserId: (self: Plugin) -> number
    Intersect: (self: Plugin, objects: { Instance }) -> Instance
    IsActivated: (self: Plugin) -> boolean
    IsActivatedWithExclusiveMouse: (self: Plugin) -> boolean
    Negate: (self: Plugin, objects: { Instance }) -> { Instance }
    OpenScript: (self: Plugin, script: LuaSourceContainer, lineNumber: number?) -> ()
    OpenWikiPage: (self: Plugin, url: string) -> ()
    SaveSelectedToRoblox: (self: Plugin) -> ()
    SelectRibbonTool: (self: Plugin, tool: EnumItem, position: UDim2) -> ()
    Separate: (self: Plugin, objects: { Instance }) -> { Instance }
    SetSetting: (self: Plugin, key: string, value: any) -> ()
    StartDrag: (self: Plugin, dragData: { [string]: any }) -> ()
    Union: (self: Plugin, objects: { Instance }) -> Instance
    CreateDockWidgetPluginGui: (self: Plugin, pluginGuiId: string, dockWidgetPluginGuiInfo: DockWidgetPluginGuiInfo) -> DockWidgetPluginGui
    ImportFbxAnimation: (self: Plugin, rigModel: Instance, isR15: boolean?) -> Instance
    ImportFbxRig: (self: Plugin, isR15: boolean?) -> Instance
    PromptForExistingAssetId: (self: Plugin, assetType: string) -> number
    PromptSaveSelection: (self: Plugin, suggestedFileName: string?) -> boolean
    Deactivation: RBXScriptSignal
    Unloading: RBXScriptSignal
end

declare class PluginAction extends Instance
    ActionId: string
    AllowBinding: boolean
    StatusTip: string
    Text: string
    Triggered: RBXScriptSignal
end

declare class PluginCapabilities extends Instance
end

declare class PluginDebugService extends Instance
end

declare class PluginDragEvent extends Instance
    Data: string
    MimeType: string
    Position: Vector2
    Sender: string
end

declare class PluginGuiService extends Instance
end

declare class PluginManagementService extends Instance
end

declare class PluginManager extends Instance
    CreatePlugin: (self: PluginManager) -> Instance
    ExportPlace: (self: PluginManager, filePath: string?) -> ()
    ExportSelection: (self: PluginManager, filePath: string?) -> ()
end

declare class PluginManagerInterface extends Instance
    CreatePlugin: (self: PluginManagerInterface) -> Instance
    ExportPlace: (self: PluginManagerInterface, filePath: string?) -> ()
    ExportSelection: (self: PluginManagerInterface, filePath: string?) -> ()
end

declare class PluginMenu extends Instance
    Icon: string
    Title: string
    AddAction: (self: PluginMenu, action: Instance) -> ()
    AddMenu: (self: PluginMenu, menu: Instance) -> ()
    AddNewAction: (self: PluginMenu, actionId: string, text: string, icon: string?) -> Instance
    AddSeparator: (self: PluginMenu) -> ()
    Clear: (self: PluginMenu) -> ()
    ShowAsync: (self: PluginMenu) -> Instance
end

declare class PluginPolicyService extends Instance
end

declare class PluginToolbar extends Instance
    CreateButton: (self: PluginToolbar, buttonId: string, tooltip: string, iconname: string, text: string?) -> Instance
end

declare class PluginToolbarButton extends Instance
    ClickableWhenViewportHidden: boolean
    Enabled: boolean
    Icon: string
    SetActive: (self: PluginToolbarButton, active: boolean) -> ()
    Click: RBXScriptSignal
end

declare class PointsService extends Instance
    GetAwardablePoints: (self: PointsService) -> number
    AwardPoints: (self: PointsService, userId: number, amount: number) -> ...any
    GetGamePointBalance: (self: PointsService, userId: number) -> number
    GetPointBalance: (self: PointsService, userId: number) -> number
    PointsAwarded: RBXScriptSignal
end

declare class PolicyService extends Instance
    GetPolicyInfoForPlayerAsync: (self: PolicyService, player: Instance) -> { [string]: any }
end

declare class PoseBase extends Instance
    EasingDirection: EnumItem
    EasingStyle: EnumItem
    Weight: number
end

declare class NumberPose extends PoseBase
    Value: number
end

declare class Pose extends PoseBase
    CFrame: CFrame
    MaskWeight: number
    AddSubPose: (self: Pose, pose: Instance) -> ()
    GetSubPoses: (self: Pose) -> { Instance }
    RemoveSubPose: (self: Pose, pose: Instance) -> ()
end

declare class PostEffect extends Instance
    Enabled: boolean
end

declare class BloomEffect extends PostEffect
    Intensity: number
    Size: number
    Threshold: number
end

declare class BlurEffect extends PostEffect
    Size: number
end

declare class ColorCorrectionEffect extends PostEffect
    Brightness: number
    Contrast: number
    Saturation: number
    TintColor: Color3
end

declare class DepthOfFieldEffect extends PostEffect
    FarIntensity: number
    FocusDistance: number
    InFocusRadius: number
    NearIntensity: number
end

declare class SunRaysEffect extends PostEffect
    Intensity: number
    Spread: number
end

declare class ProcessInstancePhysicsService extends Instance
end

declare class ProximityPrompt extends Instance
    ActionText: string
    AutoLocalize: boolean
    ClickablePrompt: boolean
    Enabled: boolean
    Exclusivity: EnumItem
    GamepadKeyCode: EnumItem
    HoldDuration: number
    KeyboardKeyCode: EnumItem
    MaxActivationDistance: number
    ObjectText: string
    RequiresLineOfSight: boolean
    RootLocalizationTable: LocalizationTable
    Style: EnumItem
    UIOffset: Vector2
    InputHoldBegin: (self: ProximityPrompt) -> ()
    InputHoldEnd: (self: ProximityPrompt) -> ()
    PromptButtonHoldBegan: RBXScriptSignal
    PromptButtonHoldEnded: RBXScriptSignal
    PromptHidden: RBXScriptSignal
    PromptShown: RBXScriptSignal
    TriggerEnded: RBXScriptSignal
    Triggered: RBXScriptSignal
end

declare class ProximityPromptService extends Instance
    Enabled: boolean
    MaxPromptsVisible: number
    PromptButtonHoldBegan: RBXScriptSignal
    PromptButtonHoldEnded: RBXScriptSignal
    PromptHidden: RBXScriptSignal
    PromptShown: RBXScriptSignal
    PromptTriggerEnded: RBXScriptSignal
    PromptTriggered: RBXScriptSignal
end

declare class PublishService extends Instance
end

declare class RbxAnalyticsService extends Instance
end

declare class ReflectionMetadata extends Instance
end

declare class ReflectionMetadataCallbacks extends Instance
end

declare class ReflectionMetadataClasses extends Instance
end

declare class ReflectionMetadataEnums extends Instance
end

declare class ReflectionMetadataEvents extends Instance
end

declare class ReflectionMetadataFunctions extends Instance
end

declare class ReflectionMetadataItem extends Instance
    Browsable: boolean
    ClassCategory: string
    ClientOnly: boolean
    Constraint: string
    Deprecated: boolean
    EditingDisabled: boolean
    EditorType: string
    FFlag: string
    IsBackend: boolean
    PropertyOrder: number
    ScriptContext: string
    ServerOnly: boolean
    SliderScaling: string
    UIMaximum: number
    UIMinimum: number
    UINumTicks: number
end

declare class ReflectionMetadataClass extends ReflectionMetadataItem
    ExplorerImageIndex: number
    ExplorerOrder: number
    Insertable: boolean
    PreferredParent: string
end

declare class ReflectionMetadataEnum extends ReflectionMetadataItem
end

declare class ReflectionMetadataEnumItem extends ReflectionMetadataItem
end

declare class ReflectionMetadataMember extends ReflectionMetadataItem
end

declare class ReflectionMetadataProperties extends Instance
end

declare class ReflectionMetadataYieldFunctions extends Instance
end

declare class RemoteCursorService extends Instance
end

declare class RemoteDebuggerServer extends Instance
end

declare class RemoteEvent extends Instance
    FireAllClients: (self: RemoteEvent, ...any) -> ()
    FireClient: (self: RemoteEvent, player: Player, ...any) -> ()
    FireServer: (self: RemoteEvent, ...any) -> ()
    OnClientEvent: RBXScriptSignal
    OnServerEvent: RBXScriptSignal
end

declare class RemoteFunction extends Instance
    InvokeClient: (self: RemoteFunction, player: Player, ...any) -> ...any
    InvokeServer: (self: RemoteFunction, ...any) -> ...any
    OnClientInvoke: (...any) -> ...any?
    OnServerInvoke: (player: Player, ...any) -> ...any?
end

declare class RenderSettings extends Instance
    AutoFRMLevel: number
    EagerBulkExecution: boolean
    EditQualityLevel: EnumItem
    _Enable_VR_Mode: boolean
    EnableFRM: boolean
    ExportMergeByMaterial: boolean
    FrameRateManager: EnumItem
    GraphicsMode: EnumItem
    MeshCacheSize: number
    MeshPartDetailLevel: EnumItem
    QualityLevel: EnumItem
    ReloadAssets: boolean
    RenderCSGTrianglesDebug: boolean
    ShowBoundingBoxes: boolean
    ViewMode: EnumItem
    GetMaxQualityLevel: (self: RenderSettings) -> number
end

declare class RenderingTest extends Instance
    CFrame: CFrame
    ComparisonDiffThreshold: number
    ComparisonMethod: EnumItem
    ComparisonPsnrThreshold: number
    Description: string
    FieldOfView: number
    Orientation: Vector3
    PerfTest: boolean
    Position: Vector3
    QualityLevel: number
    ShouldSkip: boolean
    Ticket: string
    Timeout: number
    RenderdocTriggerCapture: (self: RenderingTest) -> ()
end

declare class ReplicatedFirst extends Instance
    RemoveDefaultLoadingScreen: (self: ReplicatedFirst) -> ()
end

declare class ReplicatedStorage extends Instance
end

declare class RobloxPluginGuiService extends Instance
end

declare class RobloxReplicatedStorage extends Instance
end

declare class RobloxServerStorage extends Instance
end

declare class RomarkService extends Instance
end

declare class RotationCurve extends Instance
    Length: number
    GetKeyAtIndex: (self: RotationCurve, index: number) -> RotationCurveKey
    GetKeyIndicesAtTime: (self: RotationCurve, time: number) -> { any }
    GetKeys: (self: RotationCurve) -> { any }
    GetValueAtTime: (self: RotationCurve, time: number) -> CFrame?
    InsertKey: (self: RotationCurve, key: RotationCurveKey) -> { any }
    RemoveKeyAtIndex: (self: RotationCurve, startingIndex: number, count: number?) -> number
    SetKeys: (self: RotationCurve, keys: { any }) -> number
end

declare class RtMessagingService extends Instance
end

declare class RunService extends Instance
    BindToRenderStep: (self: RunService, name: string, priority: number, _function: (...any) -> ...any) -> ()
    IsClient: (self: RunService) -> boolean
    IsEdit: (self: RunService) -> boolean
    IsRunMode: (self: RunService) -> boolean
    IsRunning: (self: RunService) -> boolean
    IsServer: (self: RunService) -> boolean
    IsStudio: (self: RunService) -> boolean
    Pause: (self: RunService) -> ()
    Reset: (self: RunService) -> ()
    Run: (self: RunService) -> ()
    Stop: (self: RunService) -> ()
    UnbindFromRenderStep: (self: RunService, name: string) -> ()
    Heartbeat: RBXScriptSignal
    PostSimulation: RBXScriptSignal
    PreAnimation: RBXScriptSignal
    PreRender: RBXScriptSignal
    PreSimulation: RBXScriptSignal
    RenderStepped: RBXScriptSignal
    Stepped: RBXScriptSignal
end

declare class RuntimeScriptService extends Instance
end

declare class SafetyService extends Instance
end

declare class ScreenshotHud extends Instance
    CameraButtonIcon: string
    CameraButtonPosition: UDim2
    CloseButtonPosition: UDim2
    CloseWhenScreenshotTaken: boolean
    ExperienceNameOverlayEnabled: boolean
    OverlayFont: EnumItem
    UsernameOverlayEnabled: boolean
    Visible: boolean
end

declare class ScriptBuilder extends Instance
end

declare class SyncScriptBuilder extends ScriptBuilder
    CompileTarget: EnumItem
    CoverageInfo: boolean
    DebugInfo: boolean
    PackAsSource: boolean
    RawBytecode: boolean
end

declare class ScriptChangeService extends Instance
end

declare class ScriptCloneWatcher extends Instance
end

declare class ScriptCloneWatcherHelper extends Instance
end

declare class ScriptCommitService extends Instance
end

declare class ScriptContext extends Instance
    SetTimeout: (self: ScriptContext, seconds: number) -> ()
    Error: RBXScriptSignal
end

declare class ScriptDebugger extends Instance
    CurrentLine: number
    IsDebugging: boolean
    IsPaused: boolean
    Script: Instance
    AddWatch: (self: ScriptDebugger, expression: string) -> Instance
    GetBreakpoints: (self: ScriptDebugger) -> { Instance }
    GetGlobals: (self: ScriptDebugger, stackFrame: number?) -> { [any]: any }
    GetLocals: (self: ScriptDebugger, stackFrame: number?) -> { [any]: any }
    GetStack: (self: ScriptDebugger) -> { any }
    GetUpvalues: (self: ScriptDebugger, stackFrame: number?) -> { [any]: any }
    GetWatchValue: (self: ScriptDebugger, watch: Instance) -> any
    GetWatches: (self: ScriptDebugger) -> { Instance }
    SetBreakpoint: (self: ScriptDebugger, line: number, isContextDependentBreakpoint: boolean) -> Instance
    SetGlobal: (self: ScriptDebugger, name: string, value: any, stackFrame: number) -> ()
    SetLocal: (self: ScriptDebugger, name: string, value: any, stackFrame: number?) -> ()
    SetUpvalue: (self: ScriptDebugger, name: string, value: any, stackFrame: number?) -> ()
    BreakpointAdded: RBXScriptSignal
    BreakpointRemoved: RBXScriptSignal
    EncounteredBreak: RBXScriptSignal
    Resuming: RBXScriptSignal
    WatchAdded: RBXScriptSignal
    WatchRemoved: RBXScriptSignal
end

declare class ScriptDocument extends Instance
    GetLine: (self: ScriptDocument, lineIndex: number?) -> string
    GetLineCount: (self: ScriptDocument) -> number
    GetScript: (self: ScriptDocument) -> LuaSourceContainer
    GetSelectedText: (self: ScriptDocument) -> string
    GetSelection: (self: ScriptDocument) -> ...any
    GetSelectionEnd: (self: ScriptDocument) -> ...any
    GetSelectionStart: (self: ScriptDocument) -> ...any
    GetText: (self: ScriptDocument, startLine: number?, startCharacter: number?, endLine: number?, endCharacter: number?) -> string
    GetViewport: (self: ScriptDocument) -> ...any
    HasSelectedText: (self: ScriptDocument) -> boolean
    IsCommandBar: (self: ScriptDocument) -> boolean
    CloseAsync: (self: ScriptDocument) -> ...any
    EditTextAsync: (self: ScriptDocument, newText: string, startLine: number, startCharacter: number, endLine: number, endCharacter: number) -> ...any
    ForceSetSelectionAsync: (self: ScriptDocument, cursorLine: number, cursorCharacter: number, anchorLine: number?, anchorCharacter: number?) -> ...any
    RequestSetSelectionAsync: (self: ScriptDocument, cursorLine: number, cursorCharacter: number, anchorLine: number?, anchorCharacter: number?) -> ...any
    SelectionChanged: RBXScriptSignal
    ViewportChanged: RBXScriptSignal
end

declare class ScriptEditorService extends Instance
    DeregisterAutocompleteCallback: (self: ScriptEditorService, name: string) -> ()
    DeregisterScriptAnalysisCallback: (self: ScriptEditorService, name: string) -> ()
    FindScriptDocument: (self: ScriptEditorService, script: LuaSourceContainer) -> ScriptDocument
    GetEditorSource: (self: ScriptEditorService, script: LuaSourceContainer) -> string
    GetScriptDocuments: (self: ScriptEditorService) -> { Instance }
    RegisterAutocompleteCallback: (self: ScriptEditorService, name: string, priority: number, callbackFunction: (...any) -> ...any) -> ()
    RegisterScriptAnalysisCallback: (self: ScriptEditorService, name: string, priority: number, callbackFunction: (...any) -> ...any) -> ()
    OpenScriptDocumentAsync: (self: ScriptEditorService, script: LuaSourceContainer) -> ...any
    TextDocumentDidChange: RBXScriptSignal
    TextDocumentDidClose: RBXScriptSignal
    TextDocumentDidOpen: RBXScriptSignal
end

declare class ScriptRegistrationService extends Instance
end

declare class ScriptRuntime extends Instance
end

declare class ScriptService extends Instance
end

declare class Selection extends Instance
    SelectionThickness: number
    Add: (self: Selection, instancesToAdd: { Instance }) -> ()
    Get: (self: Selection) -> { Instance }
    Remove: (self: Selection, instancesToRemove: { Instance }) -> ()
    Set: (self: Selection, selection: { Instance }) -> ()
    SelectionChanged: RBXScriptSignal
end

declare class SelectionHighlightManager extends Instance
end

declare class SensorBase extends Instance
    UpdateType: EnumItem
    Sense: (self: SensorBase) -> ()
    OnSensorOutputChanged: RBXScriptSignal
end

declare class BuoyancySensor extends SensorBase
    FullySubmerged: boolean
    TouchingSurface: boolean
end

declare class ControllerSensor extends SensorBase
end

declare class ControllerPartSensor extends ControllerSensor
    HitFrame: CFrame
    HitNormal: Vector3
    SearchDistance: number
    SensedPart: BasePart
    SensorMode: EnumItem
end

declare class ServerScriptService extends Instance
end

declare class ServerStorage extends Instance
end

declare class ServiceProvider extends Instance
    FindService: (self: ServiceProvider, className: string) -> Instance
    GetService: (self: ServiceProvider, className: string) -> Instance
    getService: (self: ServiceProvider, className: string) -> Instance
    service: (self: ServiceProvider, className: string) -> Instance
    Close: RBXScriptSignal
    ServiceAdded: RBXScriptSignal
    ServiceRemoving: RBXScriptSignal
end

declare class DataModel extends ServiceProvider
    CreatorId: number
    CreatorType: EnumItem
    GameId: number
    GearGenreSetting: EnumItem
    Genre: EnumItem
    JobId: string
    PlaceId: number
    PlaceVersion: number
    PrivateServerId: string
    PrivateServerOwnerId: number
    VIPServerId: string
    VIPServerOwnerId: number
    Workspace: Workspace
    lighting: Instance
    workspace: Workspace
    BindToClose: (self: DataModel, _function: (...any) -> ...any) -> ()
    GetJobsInfo: (self: DataModel) -> { any }
    GetMessage: (self: DataModel) -> string
    GetObjects: (self: DataModel, url: string) -> { Instance }
    GetRemoteBuildMode: (self: DataModel) -> boolean
    IsGearTypeAllowed: (self: DataModel, gearType: EnumItem) -> boolean
    IsLoaded: (self: DataModel) -> boolean
    SetPlaceId: (self: DataModel, placeId: number) -> ()
    SetUniverseId: (self: DataModel, universeId: number) -> ()
    SavePlace: (self: DataModel, saveFilter: EnumItem?) -> boolean
    AllowedGearTypeChanged: RBXScriptSignal
    GraphicsQualityChangeRequest: RBXScriptSignal
    ItemChanged: RBXScriptSignal
    Loaded: RBXScriptSignal
    OnClose: () -> ...any?
    AdService: AdService
    AnalyticsService: AnalyticsService
    AnimationClipProvider: AnimationClipProvider
    AnimationFromVideoCreatorService: AnimationFromVideoCreatorService
    AnimationFromVideoCreatorStudioService: AnimationFromVideoCreatorStudioService
    AppStorageService: AppStorageService
    AppUpdateService: AppUpdateService
    AssetCounterService: AssetCounterService
    AssetDeliveryProxy: AssetDeliveryProxy
    AssetImportService: AssetImportService
    AssetManagerService: AssetManagerService
    AssetService: AssetService
    AvatarChatService: AvatarChatService
    AvatarEditorService: AvatarEditorService
    AvatarImportService: AvatarImportService
    BadgeService: BadgeService
    BrowserService: BrowserService
    BulkImportService: BulkImportService
    CSGDictionaryService: CSGDictionaryService
    CacheableContentProvider: CacheableContentProvider
    CalloutService: CalloutService
    CaptureService: CaptureService
    ChangeHistoryService: ChangeHistoryService
    Chat: Chat
    ClusterPacketCache: ClusterPacketCache
    CollectionService: CollectionService
    CommandService: CommandService
    ConfigureServerService: ConfigureServerService
    ContentProvider: ContentProvider
    ContextActionService: ContextActionService
    ControllerService: ControllerService
    CookiesService: CookiesService
    CoreGui: CoreGui
    CorePackages: CorePackages
    CoreScriptDebuggingManagerHelper: CoreScriptDebuggingManagerHelper
    CoreScriptSyncService: CoreScriptSyncService
    CrossDMScriptChangeListener: CrossDMScriptChangeListener
    DataModelPatchService: DataModelPatchService
    DataStoreService: DataStoreService
    Debris: Debris
    DebuggablePluginWatcher: DebuggablePluginWatcher
    DebuggerConnectionManager: DebuggerConnectionManager
    DebuggerManager: DebuggerManager
    DebuggerUIService: DebuggerUIService
    DeviceIdService: DeviceIdService
    DraftsService: DraftsService
    DraggerService: DraggerService
    EventIngestService: EventIngestService
    ExperienceAuthService: ExperienceAuthService
    FaceAnimatorService: FaceAnimatorService
    FacialAnimationRecordingService: FacialAnimationRecordingService
    FacialAnimationStreamingServiceV2: FacialAnimationStreamingServiceV2
    FlagStandService: FlagStandService
    FlyweightService: FlyweightService
    FriendService: FriendService
    GamePassService: GamePassService
    GamepadService: GamepadService
    Geometry: Geometry
    GeometryService: GeometryService
    GoogleAnalyticsConfiguration: GoogleAnalyticsConfiguration
    GroupService: GroupService
    GuiService: GuiService
    GuidRegistryService: GuidRegistryService
    HSRDataContentProvider: HSRDataContentProvider
    HapticService: HapticService
    HeightmapImporterService: HeightmapImporterService
    Hopper: Hopper
    HttpRbxApiService: HttpRbxApiService
    HttpService: HttpService
    ILegacyStudioBridge: ILegacyStudioBridge
    IXPService: IXPService
    IncrementalPatchBuilder: IncrementalPatchBuilder
    InsertService: InsertService
    JointsService: JointsService
    KeyboardService: KeyboardService
    KeyframeSequenceProvider: KeyframeSequenceProvider
    LSPFileSyncService: LSPFileSyncService
    LanguageService: LanguageService
    LegacyStudioBridge: LegacyStudioBridge
    Lighting: Lighting
    LiveScriptingService: LiveScriptingService
    LocalStorageService: LocalStorageService
    LocalizationService: LocalizationService
    LodDataService: LodDataService
    LogService: LogService
    LoginService: LoginService
    LuaWebService: LuaWebService
    LuauScriptAnalyzerService: LuauScriptAnalyzerService
    MarketplaceService: MarketplaceService
    MaterialGenerationService: MaterialGenerationService
    MaterialService: MaterialService
    MemStorageService: MemStorageService
    MemoryStoreService: MemoryStoreService
    MeshContentProvider: MeshContentProvider
    MessageBusService: MessageBusService
    MessagingService: MessagingService
    MetaBreakpointManager: MetaBreakpointManager
    MouseService: MouseService
    NetworkClient: NetworkClient
    NetworkServer: NetworkServer
    NetworkSettings: NetworkSettings
    NonReplicatedCSGDictionaryService: NonReplicatedCSGDictionaryService
    NotificationService: NotificationService
    OmniRecommendationsService: OmniRecommendationsService
    OpenCloudService: OpenCloudService
    PackageService: PackageService
    PackageUIService: PackageUIService
    PatchBundlerFileWatch: PatchBundlerFileWatch
    PathfindingService: PathfindingService
    PermissionsService: PermissionsService
    PhysicsService: PhysicsService
    PlaceStatsService: PlaceStatsService
    PlacesService: PlacesService
    PlayerEmulatorService: PlayerEmulatorService
    Players: Players
    PluginDebugService: PluginDebugService
    PluginGuiService: PluginGuiService
    PluginManagementService: PluginManagementService
    PluginPolicyService: PluginPolicyService
    PointsService: PointsService
    PolicyService: PolicyService
    ProcessInstancePhysicsService: ProcessInstancePhysicsService
    ProximityPromptService: ProximityPromptService
    PublishService: PublishService
    RbxAnalyticsService: RbxAnalyticsService
    RemoteCursorService: RemoteCursorService
    RemoteDebuggerServer: RemoteDebuggerServer
    RenderSettings: RenderSettings
    ReplicatedFirst: ReplicatedFirst
    ReplicatedStorage: ReplicatedStorage
    RobloxPluginGuiService: RobloxPluginGuiService
    RobloxReplicatedStorage: RobloxReplicatedStorage
    RobloxServerStorage: RobloxServerStorage
    RomarkService: RomarkService
    RtMessagingService: RtMessagingService
    RunService: RunService
    RuntimeScriptService: RuntimeScriptService
    SafetyService: SafetyService
    ScriptChangeService: ScriptChangeService
    ScriptCloneWatcher: ScriptCloneWatcher
    ScriptCloneWatcherHelper: ScriptCloneWatcherHelper
    ScriptCommitService: ScriptCommitService
    ScriptContext: ScriptContext
    ScriptEditorService: ScriptEditorService
    ScriptRegistrationService: ScriptRegistrationService
    ScriptService: ScriptService
    Selection: Selection
    SelectionHighlightManager: SelectionHighlightManager
    ServerScriptService: ServerScriptService
    ServerStorage: ServerStorage
    ServiceVisibilityService: ServiceVisibilityService
    SessionService: SessionService
    SharedTableRegistry: SharedTableRegistry
    ShorelineUpgraderService: ShorelineUpgraderService
    SmoothVoxelsUpgraderService: SmoothVoxelsUpgraderService
    SnippetService: SnippetService
    SocialService: SocialService
    SolidModelContentProvider: SolidModelContentProvider
    SoundService: SoundService
    SpawnerService: SpawnerService
    StarterGui: StarterGui
    StarterPack: StarterPack
    StarterPlayer: StarterPlayer
    Stats: Stats
    StopWatchReporter: StopWatchReporter
    Studio: Studio
    StudioAssetService: StudioAssetService
    StudioData: StudioData
    StudioDeviceEmulatorService: StudioDeviceEmulatorService
    StudioPublishService: StudioPublishService
    StudioScriptDebugEventListener: StudioScriptDebugEventListener
    StudioSdkService: StudioSdkService
    StudioService: StudioService
    StylingService: StylingService
    TaskScheduler: TaskScheduler
    TeamCreateData: TeamCreateData
    TeamCreatePublishService: TeamCreatePublishService
    TeamCreateService: TeamCreateService
    Teams: Teams
    TeleportService: TeleportService
    TemporaryCageMeshProvider: TemporaryCageMeshProvider
    TemporaryScriptService: TemporaryScriptService
    TestService: TestService
    TextBoxService: TextBoxService
    TextChatService: TextChatService
    TextService: TextService
    ThirdPartyUserService: ThirdPartyUserService
    TimerService: TimerService
    ToastNotificationService: ToastNotificationService
    TouchInputService: TouchInputService
    TracerService: TracerService
    TutorialService: TutorialService
    TweenService: TweenService
    UGCAvatarService: UGCAvatarService
    UGCValidationService: UGCValidationService
    UnvalidatedAssetService: UnvalidatedAssetService
    UserInputService: UserInputService
    UserService: UserService
    UserStorageService: UserStorageService
    VRService: VRService
    VRStatusService: VRStatusService
    VersionControlService: VersionControlService
    VideoCaptureService: VideoCaptureService
    VideoService: VideoService
    VirtualInputManager: VirtualInputManager
    VirtualUser: VirtualUser
    VisibilityCheckDispatcher: VisibilityCheckDispatcher
    VisibilityService: VisibilityService
    Visit: Visit
    VoiceChatInternal: VoiceChatInternal
    VoiceChatService: VoiceChatService
end

declare class GenericSettings extends ServiceProvider
end

declare class AnalysticsSettings extends GenericSettings
end

declare class GlobalSettings extends GenericSettings
    GetFFlag: (self: GlobalSettings, name: string) -> boolean
    GetFVariable: (self: GlobalSettings, name: string) -> string
end

declare class UserSettings extends GenericSettings
    IsUserFeatureEnabled: (self: UserSettings, name: string) -> boolean
    Reset: (self: UserSettings) -> ()
end

declare class ServiceVisibilityService extends Instance
end

declare class SessionService extends Instance
end

declare class SharedTableRegistry extends Instance
    GetSharedTable: (self: SharedTableRegistry, name: string) -> SharedTable
    SetSharedTable: (self: SharedTableRegistry, name: string, st: SharedTable?) -> ()
end

declare class ShorelineUpgraderService extends Instance
end

declare class Sky extends Instance
    CelestialBodiesShown: boolean
    MoonAngularSize: number
    MoonTextureId: string
    SkyboxBk: string
    SkyboxDn: string
    SkyboxFt: string
    SkyboxLf: string
    SkyboxRt: string
    SkyboxUp: string
    StarCount: number
    SunAngularSize: number
    SunTextureId: string
end

declare class Smoke extends Instance
    Color: Color3
    Enabled: boolean
    Opacity: number
    RiseVelocity: number
    Size: number
    TimeScale: number
end

declare class SmoothVoxelsUpgraderService extends Instance
end

declare class SnippetService extends Instance
end

declare class SocialService extends Instance
    HideSelfView: (self: SocialService) -> ()
    PromptGameInvite: (self: SocialService, player: Instance, experienceInviteOptions: Instance?) -> ()
    PromptIrisInvite: (self: SocialService, player: Instance, tag: string) -> ()
    ShowSelfView: (self: SocialService, selfViewPosition: EnumItem?) -> ()
    CanSendGameInviteAsync: (self: SocialService, player: Instance, recipientId: number?) -> boolean
    CanSendIrisInviteAsync: (self: SocialService, player: Instance) -> boolean
    GameInvitePromptClosed: RBXScriptSignal
    IrisInvitePromptClosed: RBXScriptSignal
    OnIrisInviteInvoked: (tag: string, irisParticipantIds: { any }) -> Instance?
end

declare class Sound extends Instance
    EmitterSize: number
    IsLoaded: boolean
    IsPaused: boolean
    IsPlaying: boolean
    LoopRegion: NumberRange
    Looped: boolean
    MaxDistance: number
    MinDistance: number
    Pitch: number
    PlayOnRemove: boolean
    PlaybackLoudness: number
    PlaybackRegion: NumberRange
    PlaybackRegionsEnabled: boolean
    PlaybackSpeed: number
    Playing: boolean
    RollOffMaxDistance: number
    RollOffMinDistance: number
    RollOffMode: EnumItem
    SoundGroup: SoundGroup
    SoundId: string
    TimeLength: number
    TimePosition: number
    Volume: number
    isPlaying: boolean
    Pause: (self: Sound) -> ()
    Play: (self: Sound) -> ()
    Resume: (self: Sound) -> ()
    Stop: (self: Sound) -> ()
    pause: (self: Sound) -> ()
    play: (self: Sound) -> ()
    stop: (self: Sound) -> ()
    DidLoop: RBXScriptSignal
    Ended: RBXScriptSignal
    Loaded: RBXScriptSignal
    Paused: RBXScriptSignal
    Played: RBXScriptSignal
    Resumed: RBXScriptSignal
    Stopped: RBXScriptSignal
end

declare class SoundEffect extends Instance
    Enabled: boolean
    Priority: number
end

declare class ChorusSoundEffect extends SoundEffect
    Depth: number
    Mix: number
    Rate: number
end

declare class CompressorSoundEffect extends SoundEffect
    Attack: number
    GainMakeup: number
    Ratio: number
    Release: number
    SideChain: Instance
    Threshold: number
end

declare class CustomSoundEffect extends SoundEffect
end

declare class AssetSoundEffect extends CustomSoundEffect
end

declare class ChannelSelectorSoundEffect extends CustomSoundEffect
    Channel: number
end

declare class DistortionSoundEffect extends SoundEffect
    Level: number
end

declare class EchoSoundEffect extends SoundEffect
    Delay: number
    DryLevel: number
    Feedback: number
    WetLevel: number
end

declare class EqualizerSoundEffect extends SoundEffect
    HighGain: number
    LowGain: number
    MidGain: number
end

declare class FlangeSoundEffect extends SoundEffect
    Depth: number
    Mix: number
    Rate: number
end

declare class PitchShiftSoundEffect extends SoundEffect
    Octave: number
end

declare class ReverbSoundEffect extends SoundEffect
    DecayTime: number
    Density: number
    Diffusion: number
    DryLevel: number
    WetLevel: number
end

declare class TremoloSoundEffect extends SoundEffect
    Depth: number
    Duty: number
    Frequency: number
end

declare class SoundGroup extends Instance
    Volume: number
end

declare class SoundService extends Instance
    AmbientReverb: EnumItem
    DistanceFactor: number
    DopplerScale: number
    RespectFilteringEnabled: boolean
    RolloffScale: number
    GetListener: (self: SoundService) -> ...any
    PlayLocalSound: (self: SoundService, sound: Instance) -> ()
    SetListener: (self: SoundService, listenerType: EnumItem, ...any) -> ()
end

declare class Sparkles extends Instance
    Color: Color3
    Enabled: boolean
    SparkleColor: Color3
    TimeScale: number
end

declare class SpawnerService extends Instance
end

declare class StackFrame extends Instance
end

declare class StandalonePluginScripts extends Instance
end

declare class StarterGear extends Instance
end

declare class StarterPack extends Instance
end

declare class StarterPlayer extends Instance
    AllowCustomAnimations: boolean
    AutoJumpEnabled: boolean
    AvatarJointUpgrade: EnumItem
    CameraMaxZoomDistance: number
    CameraMinZoomDistance: number
    CameraMode: EnumItem
    CharacterJumpHeight: number
    CharacterJumpPower: number
    CharacterMaxSlopeAngle: number
    CharacterUseJumpPower: boolean
    CharacterWalkSpeed: number
    DeathStyle: EnumItem
    DevCameraOcclusionMode: EnumItem
    DevComputerCameraMovementMode: EnumItem
    DevComputerMovementMode: EnumItem
    DevTouchCameraMovementMode: EnumItem
    DevTouchMovementMode: EnumItem
    EnableMouseLockOption: boolean
    HealthDisplayDistance: number
    HumanoidStateMachineMode: EnumItem
    LoadCharacterAppearance: boolean
    NameDisplayDistance: number
    UserEmotesEnabled: boolean
end

declare class StarterPlayerScripts extends Instance
end

declare class StarterCharacterScripts extends StarterPlayerScripts
end

declare class Stats extends Instance
    ContactsCount: number
    DataReceiveKbps: number
    DataSendKbps: number
    HeartbeatTimeMs: number
    InstanceCount: number
    MovingPrimitivesCount: number
    PhysicsReceiveKbps: number
    PhysicsSendKbps: number
    PhysicsStepTimeMs: number
    PrimitivesCount: number
    GetMemoryUsageMbForTag: (self: Stats, tag: EnumItem) -> number
    GetTotalMemoryUsageMb: (self: Stats) -> number
end

declare class StatsItem extends Instance
    DisplayName: string
    GetValue: (self: StatsItem) -> number
    GetValueString: (self: StatsItem) -> string
end

declare class RunningAverageItemDouble extends StatsItem
end

declare class RunningAverageItemInt extends StatsItem
end

declare class RunningAverageTimeIntervalItem extends StatsItem
end

declare class TotalCountTimeIntervalItem extends StatsItem
end

declare class StopWatchReporter extends Instance
end

declare class Studio extends Instance
    __TODO__Color: Color3
    __function__Color: Color3
    __local__Color: Color3
    __nil__Color: Color3
    __self__Color: Color3
    _Active_Color: Color3
    _Active_Hover_Over_Color: Color3
    _Always_Save_Script_Changes: boolean
    _Animate_Hover_Over: boolean
    _Auto_Clean_Empty_Line: boolean
    _Auto_Closing_Brackets: boolean
    _Auto_Closing_Quotes: boolean
    _Auto_Delete_Closing_Brackets_and_Quotes: boolean
    _Auto_Indent_Rule: EnumItem
    _Auto_Recovery_Enabled: boolean
    _Auto_Recovery_Interval__Minutes_: number
    _Auto_Recovery_Path: string
    _Background_Color: Color3
    _Basic_Objects_Display_Mode: EnumItem
    _Bool_Color: Color3
    _Bracket_Color: Color3
    _Built_in_Function_Color: Color3
    _Camera_Mouse_Wheel_Speed: number
    _Camera_Shift_Speed: number
    _Camera_Speed: number
    _Camera_Zoom_to_Mouse_Position: boolean
    _Clear_Output_On_Start: boolean
    CommandBarLocalState: boolean
    _Comment_Color: Color3
    _Current_Line_Highlight_Color: Color3
    _Debugger_Current_Line_Color: Color3
    _Debugger_Error_Line_Color: Color3
    DefaultScriptFileDir: string
    DeprecatedObjectsShown: boolean
    _Enable_Autocomplete: boolean
    _Enable_CoreScript_Debugger: boolean
    _Enable_Http_Sandboxing: boolean
    _Enable_Internal_Beta_Features: boolean
    _Enable_Internal_Features: boolean
    _Enable_Temporary_Tabs: boolean
    _Enable_Temporary_Tabs_In_Explorer: boolean
    _Error_Color: Color3
    _Find_Selection_Background_Color: Color3
    Font: QFont
    _Format_On_Paste: boolean
    _Format_On_Type: boolean
    _Function_Name_Color: Color3
    _Highlight_Current_Line: boolean
    _Highlight_Occurances: boolean
    HintColor: Color3
    _Hover_Animate_Speed: EnumItem
    _Hover_Over_Color: Color3
    _Indent_Using_Spaces: boolean
    InformationColor: Color3
    _Keyword_Color: Color3
    _Line_Thickness: number
    LocalAssetsFolder: string
    LuaDebuggerEnabled: boolean
    LuaDebuggerEnabledAtStartup: boolean
    _Luau_Keyword_Color: Color3
    _Matching_Word_Background_Color: Color3
    _Maximum_Output_Lines: number
    _Menu_Item_Background_Color: Color3
    _Method_Color: Color3
    _Number_Color: Color3
    _Only_Play_Audio_from_Window_in_Focus: boolean
    _Operator_Color: Color3
    _Output_Font: QFont
    _Output_Layout_Mode: EnumItem
    PermissionLevelShown: EnumItem
    PluginDebuggingEnabled: boolean
    PluginsDir: string
    _Primary_Text_Color: Color3
    _Property_Color: Color3
    _Render_Throttle_Percentage: number
    _Respect_Studio_shortcuts_when_game_has_focus: boolean
    _Ruler_Color: Color3
    Rulers: string
    RuntimeUndoBehavior: EnumItem
    _Script_Editor_Color_Preset: EnumItem
    _Script_Editor_Scrollbar_Background_Color: Color3
    _Script_Editor_Scrollbar_Handle_Color: Color3
    ScriptTimeoutLength: number
    _Scroll_Past_Last_Line: boolean
    _Secondary_Text_Color: Color3
    _Select_Color: Color3
    _Select_Hover_Color: Color3
    _Selected_Menu_Item_Background_Color: Color3
    _Selected_Text_Color: Color3
    _Selection_Background_Color: Color3
    _Selection_Color: Color3
    _Server_Audio_Behavior: EnumItem
    _Set_Pivot_of_Imported_Parts: boolean
    _Show_Core_GUI_in_Explorer_while_Playing: boolean
    _Show_Diagnostics_Bar: boolean
    _Show_FileSyncService: boolean
    _Show_Hidden_Objects_in_Explorer: boolean
    _Show_Hover_Over: boolean
    _Show_Navigation_Mesh: boolean
    _Show_Plugin_GUI_Service_in_Explorer: boolean
    _Show_Whitespace: boolean
    _Show_plus_button_on_hover_in_Explorer: boolean
    _Skip_Closing_Brackets_and_Quotes: boolean
    _String_Color: Color3
    _Tab_Width: number
    _Text_Color: Color3
    _Text_Wrapping: boolean
    Theme: Instance
    _UI_Theme: EnumItem
    _Warning_Color: Color3
    _Whitespace_Color: Color3
    GetAvailableThemes: (self: Studio) -> { any }
    ThemeChanged: RBXScriptSignal
end

declare class StudioAssetService extends Instance
end

declare class StudioCallout extends Instance
end

declare class StudioData extends Instance
end

declare class StudioDeviceEmulatorService extends Instance
end

declare class StudioObjectBase extends Instance
end

declare class StudioWidget extends StudioObjectBase
end

declare class StudioPublishService extends Instance
end

declare class StudioScriptDebugEventListener extends Instance
end

declare class StudioSdkService extends Instance
end

declare class StudioService extends Instance
    ActiveScript: Instance
    DraggerSolveConstraints: boolean
    DrawConstraintsOnTop: boolean
    GridSize: number
    RotateIncrement: number
    ShowConstraintDetails: boolean
    StudioLocaleId: string
    UseLocalSpace: boolean
    GetClassIcon: (self: StudioService, className: string) -> { [string]: any }
    GetUserId: (self: StudioService) -> number
    GizmoRaycast: (self: StudioService, origin: Vector3, direction: Vector3, raycastParams: RaycastParams?) -> RaycastResult
    PromptImportFile: (self: StudioService, fileTypeFilter: { any }?) -> Instance
    PromptImportFiles: (self: StudioService, fileTypeFilter: { any }?) -> { Instance }
end

declare class StudioTheme extends Instance
    GetColor: (self: StudioTheme, styleguideitem: EnumItem, modifier: EnumItem?) -> Color3
end

declare class StyleBase extends Instance
    GetStyleRules: (self: StyleBase) -> { Instance }
    InsertStyleRule: (self: StyleBase, rule: StyleRule, index: number?) -> ()
    SetStyleRules: (self: StyleBase, rules: { Instance }) -> ()
    StyleRulesChanged: RBXScriptSignal
end

declare class StyleRule extends StyleBase
    Selector: string
    SelectorError: string
    GetProperties: (self: StyleRule) -> { [string]: any }
    GetProperty: (self: StyleRule, name: string) -> any
    SetProperties: (self: StyleRule, table: { [string]: any }) -> ()
    SetProperty: (self: StyleRule, name: string, value: any) -> ()
end

declare class StyleSheet extends StyleBase
    GetDerives: (self: StyleSheet) -> { Instance }
    SetDerives: (self: StyleSheet, derives: { Instance }) -> ()
end

declare class StyleDerive extends Instance
    StyleSheet: StyleSheet
end

declare class StyleLink extends Instance
    StyleSheet: StyleSheet
end

declare class StylingService extends Instance
end

declare class SurfaceAppearance extends Instance
    AlphaMode: EnumItem
    ColorMap: string
    MetalnessMap: string
    NormalMap: string
    RoughnessMap: string
end

declare class TaskScheduler extends Instance
    SchedulerDutyCycle: number
    SchedulerRate: number
    ThreadPoolConfig: EnumItem
    ThreadPoolSize: number
end

declare class Team extends Instance
    AutoAssignable: boolean
    AutoColorCharacters: boolean
    Score: number
    TeamColor: BrickColor
    GetPlayers: (self: Team) -> { Instance }
    PlayerAdded: RBXScriptSignal
    PlayerRemoved: RBXScriptSignal
end

declare class TeamCreateData extends Instance
end

declare class TeamCreatePublishService extends Instance
end

declare class TeamCreateService extends Instance
end

declare class Teams extends Instance
    GetTeams: (self: Teams) -> { Instance }
    RebalanceTeams: (self: Teams) -> ()
end

declare class TeleportAsyncResult extends Instance
    PrivateServerId: string
    ReservedServerAccessCode: string
end

declare class TeleportOptions extends Instance
    ReservedServerAccessCode: string
    ServerInstanceId: string
    ShouldReserveServer: boolean
    GetTeleportData: (self: TeleportOptions) -> any
    SetTeleportData: (self: TeleportOptions, teleportData: any) -> ()
end

declare class TeleportService extends Instance
    CustomizedTeleportUI: boolean
    GetArrivingTeleportGui: (self: TeleportService) -> Instance
    GetLocalPlayerTeleportData: (self: TeleportService) -> any
    GetTeleportSetting: (self: TeleportService, setting: string) -> any
    SetTeleportGui: (self: TeleportService, gui: Instance) -> ()
    SetTeleportSetting: (self: TeleportService, setting: string, value: any) -> ()
    Teleport: (self: TeleportService, placeId: number, player: Instance?, teleportData: any, customLoadingScreen: Instance?) -> ()
    TeleportToPlaceInstance: (self: TeleportService, placeId: number, instanceId: string, player: Instance?, spawnName: string?, teleportData: any, customLoadingScreen: Instance?) -> ()
    TeleportToPrivateServer: (self: TeleportService, placeId: number, reservedServerAccessCode: string, players: { Instance }, spawnName: string?, teleportData: any, customLoadingScreen: Instance?) -> ()
    TeleportToSpawnByName: (self: TeleportService, placeId: number, spawnName: string, player: Instance?, teleportData: any, customLoadingScreen: Instance?) -> ()
    GetPlayerPlaceInstanceAsync: (self: TeleportService, userId: number) -> ...any
    ReserveServer: (self: TeleportService, placeId: number) -> ...any
    TeleportAsync: (self: TeleportService, placeId: number, players: { Instance }, teleportOptions: Instance?) -> Instance
    TeleportPartyAsync: (self: TeleportService, placeId: number, players: { Instance }, teleportData: any, customLoadingScreen: Instance?) -> string
    LocalPlayerArrivedFromTeleport: RBXScriptSignal
    TeleportInitFailed: RBXScriptSignal
end

declare class TemporaryCageMeshProvider extends Instance
end

declare class TemporaryScriptService extends Instance
end

declare class TerrainDetail extends Instance
    ColorMap: string
    Face: EnumItem
    MaterialPattern: EnumItem
    MetalnessMap: string
    NormalMap: string
    RoughnessMap: string
    StudsPerTile: number
end

declare class TerrainRegion extends Instance
    IsSmooth: boolean
    SizeInCells: Vector3
    ConvertToSmooth: (self: TerrainRegion) -> ()
end

declare class TestService extends Instance
    AutoRuns: boolean
    Description: string
    ErrorCount: number
    ExecuteWithStudioRun: boolean
    Is30FpsThrottleEnabled: boolean
    IsPhysicsEnvironmentalThrottled: boolean
    IsSleepAllowed: boolean
    NumberOfPlayers: number
    SimulateSecondsLag: number
    TestCount: number
    Timeout: number
    WarnCount: number
    Check: (self: TestService, condition: boolean, description: string, source: Instance?, line: number?) -> ()
    Checkpoint: (self: TestService, text: string, source: Instance?, line: number?) -> ()
    Done: (self: TestService) -> ()
    Error: (self: TestService, description: string, source: Instance?, line: number?) -> ()
    Fail: (self: TestService, description: string, source: Instance?, line: number?) -> ()
    Message: (self: TestService, text: string, source: Instance?, line: number?) -> ()
    Require: (self: TestService, condition: boolean, description: string, source: Instance?, line: number?) -> ()
    ScopeTime: (self: TestService) -> { [string]: any }
    Warn: (self: TestService, condition: boolean, description: string, source: Instance?, line: number?) -> ()
    isFeatureEnabled: (self: TestService, name: string) -> boolean
    Run: (self: TestService) -> ()
    ServerCollectConditionalResult: RBXScriptSignal
    ServerCollectResult: RBXScriptSignal
end

declare class TextBoxService extends Instance
end

declare class TextChannel extends Instance
    DisplaySystemMessage: (self: TextChannel, systemMessage: string, metadata: string?) -> TextChatMessage
    AddUserAsync: (self: TextChannel, userId: number) -> ...any
    SendAsync: (self: TextChannel, message: string, metadata: string?) -> TextChatMessage
    MessageReceived: RBXScriptSignal
    OnIncomingMessage: (message: TextChatMessage) -> ...any?
    ShouldDeliverCallback: (message: TextChatMessage, textSource: TextSource) -> ...any?
end

declare class TextChatCommand extends Instance
    Enabled: boolean
    PrimaryAlias: string
    SecondaryAlias: string
    Triggered: RBXScriptSignal
end

declare class TextChatConfigurations extends Instance
end

declare class BubbleChatConfiguration extends TextChatConfigurations
    AdorneeName: string
    BackgroundColor3: Color3
    BackgroundTransparency: number
    BubbleDuration: number
    BubblesSpacing: number
    Enabled: boolean
    Font: EnumItem
    FontFace: Font
    LocalPlayerStudsOffset: Vector3
    MaxBubbles: number
    MaxDistance: number
    MinimizeDistance: number
    TailVisible: boolean
    TextColor3: Color3
    TextSize: number
    VerticalStudsOffset: number
end

declare class ChatInputBarConfiguration extends TextChatConfigurations
    AbsolutePosition: Vector2
    AbsoluteSize: Vector2
    AutocompleteEnabled: boolean
    BackgroundColor3: Color3
    BackgroundTransparency: number
    Enabled: boolean
    FontFace: Font
    IsFocused: boolean
    KeyboardKeyCode: EnumItem
    PlaceholderColor3: Color3
    TargetTextChannel: TextChannel
    TextBox: TextBox
    TextColor3: Color3
    TextSize: number
    TextStrokeColor3: Color3
    TextStrokeTransparency: number
end

declare class ChatWindowConfiguration extends TextChatConfigurations
    AbsolutePosition: Vector2
    AbsoluteSize: Vector2
    BackgroundColor3: Color3
    BackgroundTransparency: number
    Enabled: boolean
    FontFace: Font
    HeightScale: number
    HorizontalAlignment: EnumItem
    TextColor3: Color3
    TextSize: number
    TextStrokeColor3: Color3
    TextStrokeTransparency: number
    VerticalAlignment: EnumItem
    WidthScale: number
end

declare class TextChatMessage extends Instance
    BubbleChatMessageProperties: BubbleChatMessageProperties
    MessageId: string
    Metadata: string
    PrefixText: string
    Status: EnumItem
    Text: string
    TextChannel: TextChannel
    TextSource: TextSource
    Timestamp: DateTime
end

declare class TextChatMessageProperties extends Instance
    PrefixText: string
    Text: string
end

declare class TextChatService extends Instance
    ChatVersion: EnumItem
    CreateDefaultCommands: boolean
    CreateDefaultTextChannels: boolean
    DisplayBubble: (self: TextChatService, partOrCharacter: Instance, message: string) -> ()
    CanUserChatAsync: (self: TextChatService, userId: number) -> boolean
    CanUsersChatAsync: (self: TextChatService, userIdFrom: number, userIdTo: number) -> boolean
    BubbleDisplayed: RBXScriptSignal
    MessageReceived: RBXScriptSignal
    SendingMessage: RBXScriptSignal
    OnBubbleAdded: (message: TextChatMessage, adornee: Instance) -> ...any?
    OnIncomingMessage: (message: TextChatMessage) -> ...any?
end

declare class TextFilterResult extends Instance
    GetChatForUserAsync: (self: TextFilterResult, toUserId: number) -> string
    GetNonChatStringForBroadcastAsync: (self: TextFilterResult) -> string
    GetNonChatStringForUserAsync: (self: TextFilterResult, toUserId: number) -> string
end

declare class TextFilterTranslatedResult extends Instance
    SourceLanguage: string
    SourceText: TextFilterResult
    GetTranslationForLocale: (self: TextFilterTranslatedResult, locale: string) -> TextFilterResult
    GetTranslations: (self: TextFilterTranslatedResult) -> { [string]: any }
end

declare class TextService extends Instance
    GetTextSize: (self: TextService, string: string, fontSize: number, font: EnumItem, frameSize: Vector2) -> Vector2
    FilterAndTranslateStringAsync: (self: TextService, stringToFilter: string, fromUserId: number, targetLocales: { any }, textContext: EnumItem?) -> Instance
    FilterStringAsync: (self: TextService, stringToFilter: string, fromUserId: number, textContext: EnumItem?) -> Instance
    GetFamilyInfoAsync: (self: TextService, assetId: string) -> { [string]: any }
    GetTextBoundsAsync: (self: TextService, params: GetTextBoundsParams) -> Vector2
end

declare class TextSource extends Instance
    CanSend: boolean
    UserId: number
end

declare class ThirdPartyUserService extends Instance
end

declare class ThreadState extends Instance
end

declare class TimerService extends Instance
end

declare class ToastNotificationService extends Instance
end

declare class TouchInputService extends Instance
end

declare class TouchTransmitter extends Instance
end

declare class TracerService extends Instance
end

declare class TrackerLodController extends Instance
    AudioMode: EnumItem
    VideoExtrapolationMode: EnumItem
    VideoLodMode: EnumItem
    VideoMode: EnumItem
end

declare class TrackerStreamAnimation extends Instance
end

declare class Trail extends Instance
    Attachment0: Attachment
    Attachment1: Attachment
    Brightness: number
    Color: ColorSequence
    Enabled: boolean
    FaceCamera: boolean
    Lifetime: number
    LightEmission: number
    LightInfluence: number
    MaxLength: number
    MinLength: number
    Texture: string
    TextureLength: number
    TextureMode: EnumItem
    Transparency: NumberSequence
    WidthScale: NumberSequence
    Clear: (self: Trail) -> ()
end

declare class Translator extends Instance
    LocaleId: string
    FormatByKey: (self: Translator, key: string, args: any) -> string
    Translate: (self: Translator, context: Instance, text: string) -> string
end

declare class TutorialService extends Instance
end

declare class TweenBase extends Instance
    PlaybackState: EnumItem
    Cancel: (self: TweenBase) -> ()
    Pause: (self: TweenBase) -> ()
    Play: (self: TweenBase) -> ()
    Completed: RBXScriptSignal
end

declare class Tween extends TweenBase
    Instance: Instance
    TweenInfo: TweenInfo
end

declare class TweenService extends Instance
    Create: (self: TweenService, instance: Instance, tweenInfo: TweenInfo?, propertyTable: { [string]: any }) -> Tween
    GetValue: (self: TweenService, alpha: number, easingStyle: EnumItem, easingDirection: EnumItem) -> number
end

declare class UGCAvatarService extends Instance
end

declare class UGCValidationService extends Instance
end

declare class UIBase extends Instance
end

declare class UIComponent extends UIBase
end

declare class UIConstraint extends UIComponent
end

declare class UIAspectRatioConstraint extends UIConstraint
    AspectRatio: number
    AspectType: EnumItem
    DominantAxis: EnumItem
end

declare class UISizeConstraint extends UIConstraint
    MaxSize: Vector2
    MinSize: Vector2
end

declare class UITextSizeConstraint extends UIConstraint
    MaxTextSize: number
    MinTextSize: number
end

declare class UICorner extends UIComponent
    CornerRadius: UDim
end

declare class UIGradient extends UIComponent
    Color: ColorSequence
    Enabled: boolean
    Offset: Vector2
    Rotation: number
    Transparency: NumberSequence
end

declare class UILayout extends UIComponent
end

declare class UIGridStyleLayout extends UILayout
    AbsoluteContentSize: Vector2
    FillDirection: EnumItem
    HorizontalAlignment: EnumItem
    SortOrder: EnumItem
    VerticalAlignment: EnumItem
    ApplyLayout: (self: UIGridStyleLayout) -> ()
    SetCustomSortFunction: (self: UIGridStyleLayout, _function: (...any) -> ...any?) -> ()
end

declare class UIGridLayout extends UIGridStyleLayout
    AbsoluteCellCount: Vector2
    AbsoluteCellSize: Vector2
    CellPadding: UDim2
    CellSize: UDim2
    FillDirectionMaxCells: number
    StartCorner: EnumItem
end

declare class UIListLayout extends UIGridStyleLayout
    Padding: UDim
end

declare class UIPageLayout extends UIGridStyleLayout
    Animated: boolean
    Circular: boolean
    CurrentPage: GuiObject
    EasingDirection: EnumItem
    EasingStyle: EnumItem
    GamepadInputEnabled: boolean
    Padding: UDim
    ScrollWheelInputEnabled: boolean
    TouchInputEnabled: boolean
    TweenTime: number
    JumpTo: (self: UIPageLayout, page: Instance) -> ()
    JumpToIndex: (self: UIPageLayout, index: number) -> ()
    Next: (self: UIPageLayout) -> ()
    Previous: (self: UIPageLayout) -> ()
    PageEnter: RBXScriptSignal
    PageLeave: RBXScriptSignal
    Stopped: RBXScriptSignal
end

declare class UITableLayout extends UIGridStyleLayout
    FillEmptySpaceColumns: boolean
    FillEmptySpaceRows: boolean
    MajorAxis: EnumItem
    Padding: UDim2
end

declare class UIPadding extends UIComponent
    PaddingBottom: UDim
    PaddingLeft: UDim
    PaddingRight: UDim
    PaddingTop: UDim
end

declare class UIScale extends UIComponent
    Scale: number
end

declare class UIStroke extends UIComponent
    ApplyStrokeMode: EnumItem
    Color: Color3
    Enabled: boolean
    LineJoinMode: EnumItem
    Thickness: number
    Transparency: number
end

declare class UnvalidatedAssetService extends Instance
end

declare class UserGameSettings extends Instance
    ComputerCameraMovementMode: EnumItem
    ComputerMovementMode: EnumItem
    ControlMode: EnumItem
    GamepadCameraSensitivity: number
    MouseSensitivity: number
    RCCProfilerRecordFrameRate: number
    RCCProfilerRecordTimeFrame: number
    RotationType: EnumItem
    SavedQualityLevel: EnumItem
    TouchCameraMovementMode: EnumItem
    TouchMovementMode: EnumItem
    VRSmoothRotationEnabled: boolean
    VignetteEnabled: boolean
    GetCameraYInvertValue: (self: UserGameSettings) -> number
    GetOnboardingCompleted: (self: UserGameSettings, onboardingId: string) -> boolean
    InFullScreen: (self: UserGameSettings) -> boolean
    InStudioMode: (self: UserGameSettings) -> boolean
    SetCameraYInvertVisible: (self: UserGameSettings) -> ()
    SetGamepadCameraSensitivityVisible: (self: UserGameSettings) -> ()
    SetOnboardingCompleted: (self: UserGameSettings, onboardingId: string) -> ()
    FullscreenChanged: RBXScriptSignal
    StudioModeChanged: RBXScriptSignal
end

declare class UserInputService extends Instance
    AccelerometerEnabled: boolean
    GamepadEnabled: boolean
    GyroscopeEnabled: boolean
    KeyboardEnabled: boolean
    ModalEnabled: boolean
    MouseBehavior: EnumItem
    MouseDeltaSensitivity: number
    MouseEnabled: boolean
    MouseIcon: string
    MouseIconEnabled: boolean
    OnScreenKeyboardPosition: Vector2
    OnScreenKeyboardSize: Vector2
    OnScreenKeyboardVisible: boolean
    TouchEnabled: boolean
    UserHeadCFrame: CFrame
    VREnabled: boolean
    GamepadSupports: (self: UserInputService, gamepadNum: EnumItem, gamepadKeyCode: EnumItem) -> boolean
    GetConnectedGamepads: (self: UserInputService) -> { any }
    GetDeviceAcceleration: (self: UserInputService) -> InputObject
    GetDeviceGravity: (self: UserInputService) -> InputObject
    GetDeviceRotation: (self: UserInputService) -> ...any
    GetFocusedTextBox: (self: UserInputService) -> TextBox
    GetGamepadConnected: (self: UserInputService, gamepadNum: EnumItem) -> boolean
    GetGamepadState: (self: UserInputService, gamepadNum: EnumItem) -> { any }
    GetKeysPressed: (self: UserInputService) -> { any }
    GetLastInputType: (self: UserInputService) -> EnumItem
    GetMouseButtonsPressed: (self: UserInputService) -> { any }
    GetMouseDelta: (self: UserInputService) -> Vector2
    GetMouseLocation: (self: UserInputService) -> Vector2
    GetNavigationGamepads: (self: UserInputService) -> { any }
    GetStringForKeyCode: (self: UserInputService, keyCode: EnumItem) -> string
    GetSupportedGamepadKeyCodes: (self: UserInputService, gamepadNum: EnumItem) -> { any }
    GetUserCFrame: (self: UserInputService, _type: EnumItem) -> CFrame
    IsGamepadButtonDown: (self: UserInputService, gamepadNum: EnumItem, gamepadKeyCode: EnumItem) -> boolean
    IsKeyDown: (self: UserInputService, keyCode: EnumItem) -> boolean
    IsMouseButtonPressed: (self: UserInputService, mouseButton: EnumItem) -> boolean
    IsNavigationGamepad: (self: UserInputService, gamepadEnum: EnumItem) -> boolean
    RecenterUserHeadCFrame: (self: UserInputService) -> ()
    SetNavigationGamepad: (self: UserInputService, gamepadEnum: EnumItem, enabled: boolean) -> ()
    DeviceAccelerationChanged: RBXScriptSignal
    DeviceGravityChanged: RBXScriptSignal
    DeviceRotationChanged: RBXScriptSignal
    GamepadConnected: RBXScriptSignal
    GamepadDisconnected: RBXScriptSignal
    InputBegan: RBXScriptSignal
    InputChanged: RBXScriptSignal
    InputEnded: RBXScriptSignal
    JumpRequest: RBXScriptSignal
    LastInputTypeChanged: RBXScriptSignal
    PointerAction: RBXScriptSignal
    TextBoxFocusReleased: RBXScriptSignal
    TextBoxFocused: RBXScriptSignal
    TouchEnded: RBXScriptSignal
    TouchLongPress: RBXScriptSignal
    TouchMoved: RBXScriptSignal
    TouchPan: RBXScriptSignal
    TouchPinch: RBXScriptSignal
    TouchRotate: RBXScriptSignal
    TouchStarted: RBXScriptSignal
    TouchSwipe: RBXScriptSignal
    TouchTap: RBXScriptSignal
    TouchTapInWorld: RBXScriptSignal
    UserCFrameChanged: RBXScriptSignal
    WindowFocusReleased: RBXScriptSignal
    WindowFocused: RBXScriptSignal
end

declare class UserService extends Instance
    GetUserInfosByUserIdsAsync: (self: UserService, userIds: { any }) -> { any }
end

declare class VRService extends Instance
    AutomaticScaling: EnumItem
    FadeOutViewOnCollision: boolean
    GuiInputUserCFrame: EnumItem
    VREnabled: boolean
    GetTouchpadMode: (self: VRService, pad: EnumItem) -> EnumItem
    GetUserCFrame: (self: VRService, _type: EnumItem) -> CFrame
    GetUserCFrameEnabled: (self: VRService, _type: EnumItem) -> boolean
    RecenterUserHeadCFrame: (self: VRService) -> ()
    RequestNavigation: (self: VRService, cframe: CFrame, inputUserCFrame: EnumItem) -> ()
    SetTouchpadMode: (self: VRService, pad: EnumItem, mode: EnumItem) -> ()
    NavigationRequested: RBXScriptSignal
    TouchpadModeChanged: RBXScriptSignal
    UserCFrameChanged: RBXScriptSignal
    UserCFrameEnabled: RBXScriptSignal
end

declare class VRStatusService extends Instance
end

declare class ValueBase extends Instance
end

declare class BinaryStringValue extends ValueBase
    Changed: RBXScriptSignal
end

declare class BoolValue extends ValueBase
    Value: boolean
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class BrickColorValue extends ValueBase
    Value: BrickColor
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class CFrameValue extends ValueBase
    Value: CFrame
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class Color3Value extends ValueBase
    Value: Color3
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class DoubleConstrainedValue extends ValueBase
    ConstrainedValue: number
    MaxValue: number
    MinValue: number
    Value: number
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class IntConstrainedValue extends ValueBase
    ConstrainedValue: number
    MaxValue: number
    MinValue: number
    Value: number
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class IntValue extends ValueBase
    Value: number
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class NumberValue extends ValueBase
    Value: number
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class ObjectValue extends ValueBase
    Value: Instance
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class RayValue extends ValueBase
    Value: Ray
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class StringValue extends ValueBase
    Value: string
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class Vector3Value extends ValueBase
    Value: Vector3
    Changed: RBXScriptSignal
    changed: RBXScriptSignal
end

declare class Vector3Curve extends Instance
    GetValueAtTime: (self: Vector3Curve, time: number) -> { any }
    X: (self: Vector3Curve) -> FloatCurve
    Y: (self: Vector3Curve) -> FloatCurve
    Z: (self: Vector3Curve) -> FloatCurve
end

declare class VersionControlService extends Instance
end

declare class VideoCaptureService extends Instance
end

declare class VideoService extends Instance
end

declare class VirtualInputManager extends Instance
end

declare class VirtualUser extends Instance
end

declare class VisibilityCheckDispatcher extends Instance
end

declare class VisibilityService extends Instance
end

declare class Visit extends Instance
end

declare class VoiceChatInternal extends Instance
    VoiceChatState: EnumItem
    GetAudioProcessingSettings: (self: VoiceChatInternal) -> ...any
    GetMicDevices: (self: VoiceChatInternal) -> ...any
    GetParticipants: (self: VoiceChatInternal) -> { any }
    GetSpeakerDevices: (self: VoiceChatInternal) -> ...any
    GetVoiceChatApiVersion: (self: VoiceChatInternal) -> number
    GetVoiceChatAvailable: (self: VoiceChatInternal) -> number
    IsPublishPaused: (self: VoiceChatInternal) -> boolean
    IsSubscribePaused: (self: VoiceChatInternal, userId: number) -> boolean
    JoinByGroupId: (self: VoiceChatInternal, groupId: string, isMicMuted: boolean?) -> boolean
    JoinByGroupIdToken: (self: VoiceChatInternal, groupId: string, isMicMuted: boolean, isRetry: boolean?) -> boolean
    Leave: (self: VoiceChatInternal) -> ()
    PublishPause: (self: VoiceChatInternal, paused: boolean) -> boolean
    SetMicDevice: (self: VoiceChatInternal, micDeviceName: string, micDeviceGuid: string) -> ()
    SetSpeakerDevice: (self: VoiceChatInternal, speakerDeviceName: string, speakerDeviceGuid: string) -> ()
    SubscribePause: (self: VoiceChatInternal, userId: number, paused: boolean) -> boolean
    SubscribePauseAll: (self: VoiceChatInternal, paused: boolean) -> boolean
    IsVoiceEnabledForUserIdAsync: (self: VoiceChatInternal, userId: number) -> boolean
    StateChanged: RBXScriptSignal
end

declare class VoiceChatService extends Instance
    EnableDefaultVoice: boolean
    IsVoiceEnabledForUserIdAsync: (self: VoiceChatService, userId: number) -> boolean
end

declare class WeldConstraint extends Instance
    Active: boolean
    Enabled: boolean
    Part0: BasePart
    Part1: BasePart
end

declare class Wire extends Instance
    Connected: boolean
    SourceInstance: Instance
    SourceName: string
    TargetInstance: Instance
    TargetName: string
end

-- Enums ----------------------------------------------------------
-- (EnumItem itself is declared in supplements.d.lua so datatype
-- supplements that reference it resolve at parse time.)

declare class Enum_AccessModifierType
    Allow: EnumItem
    Deny: EnumItem
    GetEnumItems: (self: Enum_AccessModifierType) -> { EnumItem }
end

declare class Enum_AccessoryType
    Unknown: EnumItem
    Hat: EnumItem
    Hair: EnumItem
    Face: EnumItem
    Neck: EnumItem
    Shoulder: EnumItem
    Front: EnumItem
    Back: EnumItem
    Waist: EnumItem
    TShirt: EnumItem
    Shirt: EnumItem
    Pants: EnumItem
    Jacket: EnumItem
    Sweater: EnumItem
    Shorts: EnumItem
    LeftShoe: EnumItem
    RightShoe: EnumItem
    DressSkirt: EnumItem
    Eyebrow: EnumItem
    Eyelash: EnumItem
    GetEnumItems: (self: Enum_AccessoryType) -> { EnumItem }
end

declare class Enum_ActionType
    Nothing: EnumItem
    Pause: EnumItem
    Lose: EnumItem
    Draw: EnumItem
    Win: EnumItem
    GetEnumItems: (self: Enum_ActionType) -> { EnumItem }
end

declare class Enum_ActuatorRelativeTo
    Attachment0: EnumItem
    Attachment1: EnumItem
    World: EnumItem
    GetEnumItems: (self: Enum_ActuatorRelativeTo) -> { EnumItem }
end

declare class Enum_ActuatorType
    None: EnumItem
    Motor: EnumItem
    Servo: EnumItem
    GetEnumItems: (self: Enum_ActuatorType) -> { EnumItem }
end

declare class Enum_AdShape
    HorizontalRectangle: EnumItem
    GetEnumItems: (self: Enum_AdShape) -> { EnumItem }
end

declare class Enum_AdTeleportMethod
    Undefined: EnumItem
    PortalForward: EnumItem
    InGameMenuBackButton: EnumItem
    UIBackButton: EnumItem
    GetEnumItems: (self: Enum_AdTeleportMethod) -> { EnumItem }
end

declare class Enum_AdUnitStatus
    Inactive: EnumItem
    Active: EnumItem
    GetEnumItems: (self: Enum_AdUnitStatus) -> { EnumItem }
end

declare class Enum_AdornCullingMode
    Automatic: EnumItem
    Never: EnumItem
    GetEnumItems: (self: Enum_AdornCullingMode) -> { EnumItem }
end

declare class Enum_AlignType
    Parallel: EnumItem
    Perpendicular: EnumItem
    GetEnumItems: (self: Enum_AlignType) -> { EnumItem }
end

declare class Enum_AlphaMode
    Overlay: EnumItem
    Transparency: EnumItem
    GetEnumItems: (self: Enum_AlphaMode) -> { EnumItem }
end

declare class Enum_AnalyticsEconomyAction
    Default: EnumItem
    Acquire: EnumItem
    Spend: EnumItem
    GetEnumItems: (self: Enum_AnalyticsEconomyAction) -> { EnumItem }
end

declare class Enum_AnalyticsLogLevel
    Trace: EnumItem
    Debug: EnumItem
    Information: EnumItem
    Warning: EnumItem
    Error: EnumItem
    Fatal: EnumItem
    GetEnumItems: (self: Enum_AnalyticsLogLevel) -> { EnumItem }
end

declare class Enum_AnalyticsProgressionStatus
    Default: EnumItem
    Begin: EnumItem
    Complete: EnumItem
    Abandon: EnumItem
    Fail: EnumItem
    GetEnumItems: (self: Enum_AnalyticsProgressionStatus) -> { EnumItem }
end

declare class Enum_AnimationPriority
    Idle: EnumItem
    Movement: EnumItem
    Action: EnumItem
    Action2: EnumItem
    Action3: EnumItem
    Action4: EnumItem
    Core: EnumItem
    GetEnumItems: (self: Enum_AnimationPriority) -> { EnumItem }
end

declare class Enum_AnimatorRetargetingMode
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_AnimatorRetargetingMode) -> { EnumItem }
end

declare class Enum_AppShellActionType
    None: EnumItem
    OpenApp: EnumItem
    TapChatTab: EnumItem
    TapConversationEntry: EnumItem
    TapAvatarTab: EnumItem
    ReadConversation: EnumItem
    TapGamePageTab: EnumItem
    TapHomePageTab: EnumItem
    GamePageLoaded: EnumItem
    HomePageLoaded: EnumItem
    AvatarEditorPageLoaded: EnumItem
    GetEnumItems: (self: Enum_AppShellActionType) -> { EnumItem }
end

declare class Enum_AppShellFeature
    None: EnumItem
    Chat: EnumItem
    AvatarEditor: EnumItem
    GamePage: EnumItem
    HomePage: EnumItem
    More: EnumItem
    Landing: EnumItem
    GetEnumItems: (self: Enum_AppShellFeature) -> { EnumItem }
end

declare class Enum_AppUpdateStatus
    Unknown: EnumItem
    NotSupported: EnumItem
    Failed: EnumItem
    NotAvailable: EnumItem
    Available: EnumItem
    GetEnumItems: (self: Enum_AppUpdateStatus) -> { EnumItem }
end

declare class Enum_ApplyStrokeMode
    Contextual: EnumItem
    Border: EnumItem
    GetEnumItems: (self: Enum_ApplyStrokeMode) -> { EnumItem }
end

declare class Enum_AspectType
    FitWithinMaxSize: EnumItem
    ScaleWithParentSize: EnumItem
    GetEnumItems: (self: Enum_AspectType) -> { EnumItem }
end

declare class Enum_AssetFetchStatus
    Success: EnumItem
    Failure: EnumItem
    None: EnumItem
    Loading: EnumItem
    TimedOut: EnumItem
    GetEnumItems: (self: Enum_AssetFetchStatus) -> { EnumItem }
end

declare class Enum_AssetType
    Image: EnumItem
    TShirt: EnumItem
    Audio: EnumItem
    Mesh: EnumItem
    Lua: EnumItem
    Hat: EnumItem
    Place: EnumItem
    Model: EnumItem
    Shirt: EnumItem
    Pants: EnumItem
    Decal: EnumItem
    Head: EnumItem
    Face: EnumItem
    Gear: EnumItem
    Badge: EnumItem
    Animation: EnumItem
    Torso: EnumItem
    RightArm: EnumItem
    LeftArm: EnumItem
    LeftLeg: EnumItem
    RightLeg: EnumItem
    Package: EnumItem
    GamePass: EnumItem
    Plugin: EnumItem
    MeshPart: EnumItem
    HairAccessory: EnumItem
    FaceAccessory: EnumItem
    NeckAccessory: EnumItem
    ShoulderAccessory: EnumItem
    FrontAccessory: EnumItem
    BackAccessory: EnumItem
    WaistAccessory: EnumItem
    ClimbAnimation: EnumItem
    DeathAnimation: EnumItem
    FallAnimation: EnumItem
    IdleAnimation: EnumItem
    JumpAnimation: EnumItem
    RunAnimation: EnumItem
    SwimAnimation: EnumItem
    WalkAnimation: EnumItem
    PoseAnimation: EnumItem
    MoodAnimation: EnumItem
    EarAccessory: EnumItem
    EyeAccessory: EnumItem
    EmoteAnimation: EnumItem
    Video: EnumItem
    TShirtAccessory: EnumItem
    ShirtAccessory: EnumItem
    PantsAccessory: EnumItem
    JacketAccessory: EnumItem
    SweaterAccessory: EnumItem
    ShortsAccessory: EnumItem
    LeftShoeAccessory: EnumItem
    RightShoeAccessory: EnumItem
    DressSkirtAccessory: EnumItem
    EyebrowAccessory: EnumItem
    EyelashAccessory: EnumItem
    DynamicHead: EnumItem
    FontFamily: EnumItem
    GetEnumItems: (self: Enum_AssetType) -> { EnumItem }
end

declare class Enum_AssetTypeVerification
    Default: EnumItem
    ClientOnly: EnumItem
    Always: EnumItem
    GetEnumItems: (self: Enum_AssetTypeVerification) -> { EnumItem }
end

declare class Enum_AudioSubType
    Music: EnumItem
    SoundEffect: EnumItem
    GetEnumItems: (self: Enum_AudioSubType) -> { EnumItem }
end

declare class Enum_AudioWindowSize
    Small: EnumItem
    Medium: EnumItem
    Large: EnumItem
    GetEnumItems: (self: Enum_AudioWindowSize) -> { EnumItem }
end

declare class Enum_AutoIndentRule
    Off: EnumItem
    Absolute: EnumItem
    Relative: EnumItem
    GetEnumItems: (self: Enum_AutoIndentRule) -> { EnumItem }
end

declare class Enum_AutomaticSize
    None: EnumItem
    X: EnumItem
    Y: EnumItem
    XY: EnumItem
    GetEnumItems: (self: Enum_AutomaticSize) -> { EnumItem }
end

declare class Enum_AvatarAssetType
    TShirt: EnumItem
    Hat: EnumItem
    HairAccessory: EnumItem
    FaceAccessory: EnumItem
    NeckAccessory: EnumItem
    ShoulderAccessory: EnumItem
    FrontAccessory: EnumItem
    BackAccessory: EnumItem
    WaistAccessory: EnumItem
    Shirt: EnumItem
    Pants: EnumItem
    Gear: EnumItem
    Head: EnumItem
    Face: EnumItem
    Torso: EnumItem
    RightArm: EnumItem
    LeftArm: EnumItem
    LeftLeg: EnumItem
    RightLeg: EnumItem
    ClimbAnimation: EnumItem
    FallAnimation: EnumItem
    IdleAnimation: EnumItem
    JumpAnimation: EnumItem
    RunAnimation: EnumItem
    SwimAnimation: EnumItem
    WalkAnimation: EnumItem
    MoodAnimation: EnumItem
    EmoteAnimation: EnumItem
    TShirtAccessory: EnumItem
    ShirtAccessory: EnumItem
    PantsAccessory: EnumItem
    JacketAccessory: EnumItem
    SweaterAccessory: EnumItem
    ShortsAccessory: EnumItem
    LeftShoeAccessory: EnumItem
    RightShoeAccessory: EnumItem
    DressSkirtAccessory: EnumItem
    EyebrowAccessory: EnumItem
    EyelashAccessory: EnumItem
    DynamicHead: EnumItem
    GetEnumItems: (self: Enum_AvatarAssetType) -> { EnumItem }
end

declare class Enum_AvatarChatServiceFeature
    None: EnumItem
    UniverseAudio: EnumItem
    UniverseVideo: EnumItem
    PlaceAudio: EnumItem
    PlaceVideo: EnumItem
    UserAudioEligible: EnumItem
    UserAudio: EnumItem
    UserVideoEligible: EnumItem
    UserVideo: EnumItem
    UserBanned: EnumItem
    GetEnumItems: (self: Enum_AvatarChatServiceFeature) -> { EnumItem }
end

declare class Enum_AvatarContextMenuOption
    Friend: EnumItem
    Chat: EnumItem
    Emote: EnumItem
    InspectMenu: EnumItem
    GetEnumItems: (self: Enum_AvatarContextMenuOption) -> { EnumItem }
end

declare class Enum_AvatarItemType
    Asset: EnumItem
    Bundle: EnumItem
    GetEnumItems: (self: Enum_AvatarItemType) -> { EnumItem }
end

declare class Enum_AvatarJointUpgrade
    Default: EnumItem
    Enabled: EnumItem
    Disabled: EnumItem
    GetEnumItems: (self: Enum_AvatarJointUpgrade) -> { EnumItem }
end

declare class Enum_AvatarPromptResult
    Success: EnumItem
    PermissionDenied: EnumItem
    Failed: EnumItem
    GetEnumItems: (self: Enum_AvatarPromptResult) -> { EnumItem }
end

declare class Enum_AvatarThumbnailCustomizationType
    Closeup: EnumItem
    FullBody: EnumItem
    GetEnumItems: (self: Enum_AvatarThumbnailCustomizationType) -> { EnumItem }
end

declare class Enum_AvatarUnificationMode
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_AvatarUnificationMode) -> { EnumItem }
end

declare class Enum_Axis
    X: EnumItem
    Y: EnumItem
    Z: EnumItem
    GetEnumItems: (self: Enum_Axis) -> { EnumItem }
end

declare class Enum_BinType
    Script: EnumItem
    GameTool: EnumItem
    Grab: EnumItem
    Clone: EnumItem
    Hammer: EnumItem
    GetEnumItems: (self: Enum_BinType) -> { EnumItem }
end

declare class Enum_BodyPart
    Head: EnumItem
    Torso: EnumItem
    LeftArm: EnumItem
    RightArm: EnumItem
    LeftLeg: EnumItem
    RightLeg: EnumItem
    GetEnumItems: (self: Enum_BodyPart) -> { EnumItem }
end

declare class Enum_BodyPartR15
    Head: EnumItem
    UpperTorso: EnumItem
    LowerTorso: EnumItem
    LeftFoot: EnumItem
    LeftLowerLeg: EnumItem
    LeftUpperLeg: EnumItem
    RightFoot: EnumItem
    RightLowerLeg: EnumItem
    RightUpperLeg: EnumItem
    LeftHand: EnumItem
    LeftLowerArm: EnumItem
    LeftUpperArm: EnumItem
    RightHand: EnumItem
    RightLowerArm: EnumItem
    RightUpperArm: EnumItem
    RootPart: EnumItem
    Unknown: EnumItem
    GetEnumItems: (self: Enum_BodyPartR15) -> { EnumItem }
end

declare class Enum_BorderMode
    Outline: EnumItem
    Middle: EnumItem
    Inset: EnumItem
    GetEnumItems: (self: Enum_BorderMode) -> { EnumItem }
end

declare class Enum_BreakReason
    Other: EnumItem
    Error: EnumItem
    UserBreakpoint: EnumItem
    SpecialBreakpoint: EnumItem
    GetEnumItems: (self: Enum_BreakReason) -> { EnumItem }
end

declare class Enum_BreakpointRemoveReason
    Requested: EnumItem
    ScriptChanged: EnumItem
    ScriptRemoved: EnumItem
    GetEnumItems: (self: Enum_BreakpointRemoveReason) -> { EnumItem }
end

declare class Enum_BulkMoveMode
    FireAllEvents: EnumItem
    FireCFrameChanged: EnumItem
    GetEnumItems: (self: Enum_BulkMoveMode) -> { EnumItem }
end

declare class Enum_BundleType
    BodyParts: EnumItem
    Animations: EnumItem
    Shoes: EnumItem
    DynamicHead: EnumItem
    DynamicHeadAvatar: EnumItem
    GetEnumItems: (self: Enum_BundleType) -> { EnumItem }
end

declare class Enum_Button
    Jump: EnumItem
    Dismount: EnumItem
    GetEnumItems: (self: Enum_Button) -> { EnumItem }
end

declare class Enum_ButtonStyle
    Custom: EnumItem
    RobloxButtonDefault: EnumItem
    RobloxButton: EnumItem
    RobloxRoundButton: EnumItem
    RobloxRoundDefaultButton: EnumItem
    RobloxRoundDropdownButton: EnumItem
    GetEnumItems: (self: Enum_ButtonStyle) -> { EnumItem }
end

declare class Enum_CageType
    Inner: EnumItem
    Outer: EnumItem
    GetEnumItems: (self: Enum_CageType) -> { EnumItem }
end

declare class Enum_CameraMode
    Classic: EnumItem
    LockFirstPerson: EnumItem
    GetEnumItems: (self: Enum_CameraMode) -> { EnumItem }
end

declare class Enum_CameraPanMode
    Classic: EnumItem
    EdgeBump: EnumItem
    GetEnumItems: (self: Enum_CameraPanMode) -> { EnumItem }
end

declare class Enum_CameraType
    Fixed: EnumItem
    Watch: EnumItem
    Attach: EnumItem
    Track: EnumItem
    Follow: EnumItem
    Custom: EnumItem
    Scriptable: EnumItem
    Orbital: EnumItem
    GetEnumItems: (self: Enum_CameraType) -> { EnumItem }
end

declare class Enum_CatalogCategoryFilter
    None: EnumItem
    Featured: EnumItem
    Collectibles: EnumItem
    CommunityCreations: EnumItem
    Premium: EnumItem
    Recommended: EnumItem
    GetEnumItems: (self: Enum_CatalogCategoryFilter) -> { EnumItem }
end

declare class Enum_CatalogSortAggregation
    Past12Hours: EnumItem
    PastDay: EnumItem
    Past3Days: EnumItem
    PastWeek: EnumItem
    PastMonth: EnumItem
    AllTime: EnumItem
    GetEnumItems: (self: Enum_CatalogSortAggregation) -> { EnumItem }
end

declare class Enum_CatalogSortType
    Relevance: EnumItem
    PriceHighToLow: EnumItem
    PriceLowToHigh: EnumItem
    MostFavorited: EnumItem
    RecentlyCreated: EnumItem
    Bestselling: EnumItem
    GetEnumItems: (self: Enum_CatalogSortType) -> { EnumItem }
end

declare class Enum_CellBlock
    Solid: EnumItem
    VerticalWedge: EnumItem
    CornerWedge: EnumItem
    InverseCornerWedge: EnumItem
    HorizontalWedge: EnumItem
    GetEnumItems: (self: Enum_CellBlock) -> { EnumItem }
end

declare class Enum_CellMaterial
    Empty: EnumItem
    Grass: EnumItem
    Sand: EnumItem
    Brick: EnumItem
    Granite: EnumItem
    Asphalt: EnumItem
    Iron: EnumItem
    Aluminum: EnumItem
    Gold: EnumItem
    WoodPlank: EnumItem
    WoodLog: EnumItem
    Gravel: EnumItem
    CinderBlock: EnumItem
    MossyStone: EnumItem
    Cement: EnumItem
    RedPlastic: EnumItem
    BluePlastic: EnumItem
    Water: EnumItem
    GetEnumItems: (self: Enum_CellMaterial) -> { EnumItem }
end

declare class Enum_CellOrientation
    NegZ: EnumItem
    X: EnumItem
    Z: EnumItem
    NegX: EnumItem
    GetEnumItems: (self: Enum_CellOrientation) -> { EnumItem }
end

declare class Enum_CenterDialogType
    UnsolicitedDialog: EnumItem
    PlayerInitiatedDialog: EnumItem
    ModalDialog: EnumItem
    QuitDialog: EnumItem
    GetEnumItems: (self: Enum_CenterDialogType) -> { EnumItem }
end

declare class Enum_ChatCallbackType
    OnCreatingChatWindow: EnumItem
    OnClientSendingMessage: EnumItem
    OnClientFormattingMessage: EnumItem
    OnServerReceivingMessage: EnumItem
    GetEnumItems: (self: Enum_ChatCallbackType) -> { EnumItem }
end

declare class Enum_ChatColor
    Blue: EnumItem
    Green: EnumItem
    Red: EnumItem
    White: EnumItem
    GetEnumItems: (self: Enum_ChatColor) -> { EnumItem }
end

declare class Enum_ChatMode
    Menu: EnumItem
    TextAndMenu: EnumItem
    GetEnumItems: (self: Enum_ChatMode) -> { EnumItem }
end

declare class Enum_ChatPrivacyMode
    AllUsers: EnumItem
    NoOne: EnumItem
    Friends: EnumItem
    GetEnumItems: (self: Enum_ChatPrivacyMode) -> { EnumItem }
end

declare class Enum_ChatStyle
    Classic: EnumItem
    Bubble: EnumItem
    ClassicAndBubble: EnumItem
    GetEnumItems: (self: Enum_ChatStyle) -> { EnumItem }
end

declare class Enum_ChatVersion
    LegacyChatService: EnumItem
    TextChatService: EnumItem
    GetEnumItems: (self: Enum_ChatVersion) -> { EnumItem }
end

declare class Enum_ClientAnimatorThrottlingMode
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_ClientAnimatorThrottlingMode) -> { EnumItem }
end

declare class Enum_CollisionFidelity
    Default: EnumItem
    Hull: EnumItem
    Box: EnumItem
    PreciseConvexDecomposition: EnumItem
    DynamicPreciseConvexDecomposition: EnumItem
    GetEnumItems: (self: Enum_CollisionFidelity) -> { EnumItem }
end

declare class Enum_CommandPermission
    Plugin: EnumItem
    LocalUser: EnumItem
    GetEnumItems: (self: Enum_CommandPermission) -> { EnumItem }
end

declare class Enum_CompileTarget
    Client: EnumItem
    CoreScript: EnumItem
    Studio: EnumItem
    CoreScriptRaw: EnumItem
    GetEnumItems: (self: Enum_CompileTarget) -> { EnumItem }
end

declare class Enum_CompletionItemKind
    Text: EnumItem
    Method: EnumItem
    Function: EnumItem
    Constructor: EnumItem
    Field: EnumItem
    Variable: EnumItem
    Class: EnumItem
    Interface: EnumItem
    Module: EnumItem
    Property: EnumItem
    Unit: EnumItem
    Value: EnumItem
    Enum: EnumItem
    Keyword: EnumItem
    Snippet: EnumItem
    Color: EnumItem
    File: EnumItem
    Reference: EnumItem
    Folder: EnumItem
    EnumMember: EnumItem
    Constant: EnumItem
    Struct: EnumItem
    Event: EnumItem
    Operator: EnumItem
    TypeParameter: EnumItem
    GetEnumItems: (self: Enum_CompletionItemKind) -> { EnumItem }
end

declare class Enum_CompletionItemTag
    Deprecated: EnumItem
    IncorrectIndexType: EnumItem
    PluginPermissions: EnumItem
    CommandLinePermissions: EnumItem
    RobloxPermissions: EnumItem
    AddParens: EnumItem
    PutCursorInParens: EnumItem
    TypeCorrect: EnumItem
    ClientServerBoundaryViolation: EnumItem
    GetEnumItems: (self: Enum_CompletionItemTag) -> { EnumItem }
end

declare class Enum_CompletionTriggerKind
    Invoked: EnumItem
    TriggerCharacter: EnumItem
    TriggerForIncompleteCompletions: EnumItem
    GetEnumItems: (self: Enum_CompletionTriggerKind) -> { EnumItem }
end

declare class Enum_ComputerCameraMovementMode
    Default: EnumItem
    Follow: EnumItem
    Classic: EnumItem
    Orbital: EnumItem
    CameraToggle: EnumItem
    GetEnumItems: (self: Enum_ComputerCameraMovementMode) -> { EnumItem }
end

declare class Enum_ComputerMovementMode
    Default: EnumItem
    KeyboardMouse: EnumItem
    ClickToMove: EnumItem
    GetEnumItems: (self: Enum_ComputerMovementMode) -> { EnumItem }
end

declare class Enum_ConnectionError
    OK: EnumItem
    Unknown: EnumItem
    DisconnectErrors: EnumItem
    DisconnectBadhash: EnumItem
    DisconnectSecurityKeyMismatch: EnumItem
    DisconnectNewSecurityKeyMismatch: EnumItem
    DisconnectProtocolMismatch: EnumItem
    DisconnectReceivePacketError: EnumItem
    DisconnectReceivePacketStreamError: EnumItem
    DisconnectSendPacketError: EnumItem
    DisconnectIllegalTeleport: EnumItem
    DisconnectDuplicatePlayer: EnumItem
    DisconnectDuplicateTicket: EnumItem
    DisconnectTimeout: EnumItem
    DisconnectLuaKick: EnumItem
    DisconnectOnRemoteSysStats: EnumItem
    DisconnectHashTimeout: EnumItem
    DisconnectCloudEditKick: EnumItem
    DisconnectPlayerless: EnumItem
    DisconnectEvicted: EnumItem
    DisconnectDevMaintenance: EnumItem
    DisconnectRobloxMaintenance: EnumItem
    DisconnectRejoin: EnumItem
    DisconnectConnectionLost: EnumItem
    DisconnectIdle: EnumItem
    DisconnectRaknetErrors: EnumItem
    DisconnectWrongVersion: EnumItem
    DisconnectBySecurityPolicy: EnumItem
    DisconnectBlockedIP: EnumItem
    DisconnectClientFailure: EnumItem
    DisconnectClientRequest: EnumItem
    DisconnectPrivateServerKickout: EnumItem
    DisconnectModeratedGame: EnumItem
    DisconnectRomarkEndOfTest: EnumItem
    ReplicatorTimeout: EnumItem
    PlayerRemoved: EnumItem
    DisconnectOutOfMemoryKeepPlayingLeave: EnumItem
    DisconnectCollaboratorPermissionRevoked: EnumItem
    DisconnectCollaboratorUnderage: EnumItem
    PlacelaunchErrors: EnumItem
    PlacelaunchDisabled: EnumItem
    PlacelaunchError: EnumItem
    PlacelaunchGameEnded: EnumItem
    PlacelaunchGameFull: EnumItem
    PlacelaunchUserLeft: EnumItem
    PlacelaunchRestricted: EnumItem
    PlacelaunchUnauthorized: EnumItem
    PlacelaunchFlooded: EnumItem
    PlacelaunchHashExpired: EnumItem
    PlacelaunchHashException: EnumItem
    PlacelaunchPartyCannotFit: EnumItem
    PlacelaunchHttpError: EnumItem
    PlacelaunchUserPrivacyUnauthorized: EnumItem
    PlacelaunchCustomMessage: EnumItem
    PlacelaunchOtherError: EnumItem
    TeleportErrors: EnumItem
    TeleportFailure: EnumItem
    TeleportGameNotFound: EnumItem
    TeleportGameEnded: EnumItem
    TeleportGameFull: EnumItem
    TeleportUnauthorized: EnumItem
    TeleportFlooded: EnumItem
    TeleportIsTeleporting: EnumItem
    GetEnumItems: (self: Enum_ConnectionError) -> { EnumItem }
end

declare class Enum_ConnectionState
    Connected: EnumItem
    Disconnected: EnumItem
    GetEnumItems: (self: Enum_ConnectionState) -> { EnumItem }
end

declare class Enum_ContextActionPriority
    Low: EnumItem
    Medium: EnumItem
    High: EnumItem
    GetEnumItems: (self: Enum_ContextActionPriority) -> { EnumItem }
end

declare class Enum_ContextActionResult
    Pass: EnumItem
    Sink: EnumItem
    GetEnumItems: (self: Enum_ContextActionResult) -> { EnumItem }
end

declare class Enum_ControlMode
    MouseLockSwitch: EnumItem
    Classic: EnumItem
    GetEnumItems: (self: Enum_ControlMode) -> { EnumItem }
end

declare class Enum_CoreGuiType
    PlayerList: EnumItem
    Health: EnumItem
    Backpack: EnumItem
    Chat: EnumItem
    All: EnumItem
    EmotesMenu: EnumItem
    SelfView: EnumItem
    GetEnumItems: (self: Enum_CoreGuiType) -> { EnumItem }
end

declare class Enum_CreateOutfitFailure
    InvalidName: EnumItem
    OutfitLimitReached: EnumItem
    Other: EnumItem
    GetEnumItems: (self: Enum_CreateOutfitFailure) -> { EnumItem }
end

declare class Enum_CreatorType
    User: EnumItem
    Group: EnumItem
    GetEnumItems: (self: Enum_CreatorType) -> { EnumItem }
end

declare class Enum_CreatorTypeFilter
    User: EnumItem
    Group: EnumItem
    All: EnumItem
    GetEnumItems: (self: Enum_CreatorTypeFilter) -> { EnumItem }
end

declare class Enum_CurrencyType
    Default: EnumItem
    Robux: EnumItem
    Tix: EnumItem
    GetEnumItems: (self: Enum_CurrencyType) -> { EnumItem }
end

declare class Enum_CustomCameraMode
    Default: EnumItem
    Follow: EnumItem
    Classic: EnumItem
    GetEnumItems: (self: Enum_CustomCameraMode) -> { EnumItem }
end

declare class Enum_DataStoreRequestType
    GetAsync: EnumItem
    SetIncrementAsync: EnumItem
    UpdateAsync: EnumItem
    GetSortedAsync: EnumItem
    SetIncrementSortedAsync: EnumItem
    OnUpdate: EnumItem
    GetEnumItems: (self: Enum_DataStoreRequestType) -> { EnumItem }
end

declare class Enum_DeathStyle
    Default: EnumItem
    ClassicBreakApart: EnumItem
    NonGraphic: EnumItem
    Scriptable: EnumItem
    GetEnumItems: (self: Enum_DeathStyle) -> { EnumItem }
end

declare class Enum_DebuggerEndReason
    ClientRequest: EnumItem
    Timeout: EnumItem
    InvalidHost: EnumItem
    Disconnected: EnumItem
    ServerShutdown: EnumItem
    ServerProtocolMismatch: EnumItem
    ConfigurationFailed: EnumItem
    RpcError: EnumItem
    GetEnumItems: (self: Enum_DebuggerEndReason) -> { EnumItem }
end

declare class Enum_DebuggerExceptionBreakMode
    Never: EnumItem
    Unhandled: EnumItem
    Always: EnumItem
    GetEnumItems: (self: Enum_DebuggerExceptionBreakMode) -> { EnumItem }
end

declare class Enum_DebuggerFrameType
    C: EnumItem
    Lua: EnumItem
    GetEnumItems: (self: Enum_DebuggerFrameType) -> { EnumItem }
end

declare class Enum_DebuggerPauseReason
    Unknown: EnumItem
    Requested: EnumItem
    Breakpoint: EnumItem
    Exception: EnumItem
    SingleStep: EnumItem
    Entrypoint: EnumItem
    GetEnumItems: (self: Enum_DebuggerPauseReason) -> { EnumItem }
end

declare class Enum_DebuggerStatus
    Success: EnumItem
    Timeout: EnumItem
    ConnectionLost: EnumItem
    InvalidResponse: EnumItem
    InternalError: EnumItem
    InvalidState: EnumItem
    RpcError: EnumItem
    InvalidArgument: EnumItem
    ConnectionClosed: EnumItem
    GetEnumItems: (self: Enum_DebuggerStatus) -> { EnumItem }
end

declare class Enum_DevCameraOcclusionMode
    Zoom: EnumItem
    Invisicam: EnumItem
    GetEnumItems: (self: Enum_DevCameraOcclusionMode) -> { EnumItem }
end

declare class Enum_DevComputerCameraMovementMode
    UserChoice: EnumItem
    Classic: EnumItem
    Follow: EnumItem
    Orbital: EnumItem
    CameraToggle: EnumItem
    GetEnumItems: (self: Enum_DevComputerCameraMovementMode) -> { EnumItem }
end

declare class Enum_DevComputerMovementMode
    UserChoice: EnumItem
    KeyboardMouse: EnumItem
    ClickToMove: EnumItem
    Scriptable: EnumItem
    GetEnumItems: (self: Enum_DevComputerMovementMode) -> { EnumItem }
end

declare class Enum_DevTouchCameraMovementMode
    UserChoice: EnumItem
    Classic: EnumItem
    Follow: EnumItem
    Orbital: EnumItem
    GetEnumItems: (self: Enum_DevTouchCameraMovementMode) -> { EnumItem }
end

declare class Enum_DevTouchMovementMode
    UserChoice: EnumItem
    Thumbstick: EnumItem
    DPad: EnumItem
    Thumbpad: EnumItem
    ClickToMove: EnumItem
    Scriptable: EnumItem
    DynamicThumbstick: EnumItem
    GetEnumItems: (self: Enum_DevTouchMovementMode) -> { EnumItem }
end

declare class Enum_DeveloperMemoryTag
    Internal: EnumItem
    HttpCache: EnumItem
    Instances: EnumItem
    Signals: EnumItem
    LuaHeap: EnumItem
    Script: EnumItem
    PhysicsCollision: EnumItem
    PhysicsParts: EnumItem
    GraphicsSolidModels: EnumItem
    GraphicsMeshParts: EnumItem
    GraphicsParticles: EnumItem
    GraphicsParts: EnumItem
    GraphicsSpatialHash: EnumItem
    GraphicsTerrain: EnumItem
    GraphicsTexture: EnumItem
    GraphicsTextureCharacter: EnumItem
    Sounds: EnumItem
    StreamingSounds: EnumItem
    TerrainVoxels: EnumItem
    Gui: EnumItem
    Animation: EnumItem
    Navigation: EnumItem
    GeometryCSG: EnumItem
    GetEnumItems: (self: Enum_DeveloperMemoryTag) -> { EnumItem }
end

declare class Enum_DeviceType
    Unknown: EnumItem
    Desktop: EnumItem
    Tablet: EnumItem
    Phone: EnumItem
    GetEnumItems: (self: Enum_DeviceType) -> { EnumItem }
end

declare class Enum_DialogBehaviorType
    SinglePlayer: EnumItem
    MultiplePlayers: EnumItem
    GetEnumItems: (self: Enum_DialogBehaviorType) -> { EnumItem }
end

declare class Enum_DialogPurpose
    Quest: EnumItem
    Help: EnumItem
    Shop: EnumItem
    GetEnumItems: (self: Enum_DialogPurpose) -> { EnumItem }
end

declare class Enum_DialogTone
    Neutral: EnumItem
    Friendly: EnumItem
    Enemy: EnumItem
    GetEnumItems: (self: Enum_DialogTone) -> { EnumItem }
end

declare class Enum_DominantAxis
    Width: EnumItem
    Height: EnumItem
    GetEnumItems: (self: Enum_DominantAxis) -> { EnumItem }
end

declare class Enum_DraftStatusCode
    OK: EnumItem
    DraftOutdated: EnumItem
    ScriptRemoved: EnumItem
    DraftCommitted: EnumItem
    GetEnumItems: (self: Enum_DraftStatusCode) -> { EnumItem }
end

declare class Enum_DragDetectorDragStyle
    TranslateLine: EnumItem
    TranslatePlane: EnumItem
    TranslatePlaneOrLine: EnumItem
    TranslateLineOrPlane: EnumItem
    TranslateViewPlane: EnumItem
    RotateAxis: EnumItem
    RotateTrackball: EnumItem
    Scriptable: EnumItem
    BestForDevice: EnumItem
    GetEnumItems: (self: Enum_DragDetectorDragStyle) -> { EnumItem }
end

declare class Enum_DragDetectorResponseStyle
    Geometric: EnumItem
    Physical: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_DragDetectorResponseStyle) -> { EnumItem }
end

declare class Enum_DraggerCoordinateSpace
    Object: EnumItem
    World: EnumItem
    GetEnumItems: (self: Enum_DraggerCoordinateSpace) -> { EnumItem }
end

declare class Enum_DraggerMovementMode
    Geometric: EnumItem
    Physical: EnumItem
    GetEnumItems: (self: Enum_DraggerMovementMode) -> { EnumItem }
end

declare class Enum_EasingDirection
    In: EnumItem
    Out: EnumItem
    InOut: EnumItem
    GetEnumItems: (self: Enum_EasingDirection) -> { EnumItem }
end

declare class Enum_EasingStyle
    Linear: EnumItem
    Sine: EnumItem
    Back: EnumItem
    Quad: EnumItem
    Quart: EnumItem
    Quint: EnumItem
    Bounce: EnumItem
    Elastic: EnumItem
    Exponential: EnumItem
    Circular: EnumItem
    Cubic: EnumItem
    GetEnumItems: (self: Enum_EasingStyle) -> { EnumItem }
end

declare class Enum_ElasticBehavior
    WhenScrollable: EnumItem
    Always: EnumItem
    Never: EnumItem
    GetEnumItems: (self: Enum_ElasticBehavior) -> { EnumItem }
end

declare class Enum_EnviromentalPhysicsThrottle
    DefaultAuto: EnumItem
    Disabled: EnumItem
    Always: EnumItem
    Skip2: EnumItem
    Skip4: EnumItem
    Skip8: EnumItem
    Skip16: EnumItem
    GetEnumItems: (self: Enum_EnviromentalPhysicsThrottle) -> { EnumItem }
end

declare class Enum_ExperienceAuthScope
    DefaultScope: EnumItem
    CreatorAssetsCreate: EnumItem
    GetEnumItems: (self: Enum_ExperienceAuthScope) -> { EnumItem }
end

declare class Enum_ExplosionType
    NoCraters: EnumItem
    Craters: EnumItem
    GetEnumItems: (self: Enum_ExplosionType) -> { EnumItem }
end

declare class Enum_FacialAnimationStreamingState
    None: EnumItem
    Audio: EnumItem
    Video: EnumItem
    Place: EnumItem
    Server: EnumItem
    GetEnumItems: (self: Enum_FacialAnimationStreamingState) -> { EnumItem }
end

declare class Enum_FieldOfViewMode
    Vertical: EnumItem
    Diagonal: EnumItem
    MaxAxis: EnumItem
    GetEnumItems: (self: Enum_FieldOfViewMode) -> { EnumItem }
end

declare class Enum_FillDirection
    Horizontal: EnumItem
    Vertical: EnumItem
    GetEnumItems: (self: Enum_FillDirection) -> { EnumItem }
end

declare class Enum_FilterResult
    Rejected: EnumItem
    Accepted: EnumItem
    GetEnumItems: (self: Enum_FilterResult) -> { EnumItem }
end

declare class Enum_FinishRecordingOperation
    Cancel: EnumItem
    Commit: EnumItem
    Append: EnumItem
    GetEnumItems: (self: Enum_FinishRecordingOperation) -> { EnumItem }
end

declare class Enum_FluidForces
    Default: EnumItem
    Experimental: EnumItem
    GetEnumItems: (self: Enum_FluidForces) -> { EnumItem }
end

declare class Enum_Font
    Legacy: EnumItem
    Arial: EnumItem
    ArialBold: EnumItem
    SourceSans: EnumItem
    SourceSansBold: EnumItem
    SourceSansSemibold: EnumItem
    SourceSansLight: EnumItem
    SourceSansItalic: EnumItem
    Bodoni: EnumItem
    Garamond: EnumItem
    Cartoon: EnumItem
    Code: EnumItem
    Highway: EnumItem
    SciFi: EnumItem
    Arcade: EnumItem
    Fantasy: EnumItem
    Antique: EnumItem
    Gotham: EnumItem
    GothamMedium: EnumItem
    GothamBold: EnumItem
    GothamBlack: EnumItem
    AmaticSC: EnumItem
    Bangers: EnumItem
    Creepster: EnumItem
    DenkOne: EnumItem
    Fondamento: EnumItem
    FredokaOne: EnumItem
    GrenzeGotisch: EnumItem
    IndieFlower: EnumItem
    JosefinSans: EnumItem
    Jura: EnumItem
    Kalam: EnumItem
    LuckiestGuy: EnumItem
    Merriweather: EnumItem
    Michroma: EnumItem
    Nunito: EnumItem
    Oswald: EnumItem
    PatrickHand: EnumItem
    PermanentMarker: EnumItem
    Roboto: EnumItem
    RobotoCondensed: EnumItem
    RobotoMono: EnumItem
    Sarpanch: EnumItem
    SpecialElite: EnumItem
    TitilliumWeb: EnumItem
    Ubuntu: EnumItem
    Unknown: EnumItem
    GetEnumItems: (self: Enum_Font) -> { EnumItem }
end

declare class Enum_FontSize
    Size8: EnumItem
    Size9: EnumItem
    Size10: EnumItem
    Size11: EnumItem
    Size12: EnumItem
    Size14: EnumItem
    Size18: EnumItem
    Size24: EnumItem
    Size36: EnumItem
    Size48: EnumItem
    Size28: EnumItem
    Size32: EnumItem
    Size42: EnumItem
    Size60: EnumItem
    Size96: EnumItem
    GetEnumItems: (self: Enum_FontSize) -> { EnumItem }
end

declare class Enum_FontStyle
    Normal: EnumItem
    Italic: EnumItem
    GetEnumItems: (self: Enum_FontStyle) -> { EnumItem }
end

declare class Enum_FontWeight
    Thin: EnumItem
    ExtraLight: EnumItem
    Light: EnumItem
    Regular: EnumItem
    Medium: EnumItem
    SemiBold: EnumItem
    Bold: EnumItem
    ExtraBold: EnumItem
    Heavy: EnumItem
    GetEnumItems: (self: Enum_FontWeight) -> { EnumItem }
end

declare class Enum_ForceLimitMode
    Magnitude: EnumItem
    PerAxis: EnumItem
    GetEnumItems: (self: Enum_ForceLimitMode) -> { EnumItem }
end

declare class Enum_FormFactor
    Symmetric: EnumItem
    Brick: EnumItem
    Plate: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_FormFactor) -> { EnumItem }
end

declare class Enum_FrameStyle
    Custom: EnumItem
    ChatBlue: EnumItem
    RobloxSquare: EnumItem
    RobloxRound: EnumItem
    ChatGreen: EnumItem
    ChatRed: EnumItem
    DropShadow: EnumItem
    GetEnumItems: (self: Enum_FrameStyle) -> { EnumItem }
end

declare class Enum_FramerateManagerMode
    Automatic: EnumItem
    On: EnumItem
    Off: EnumItem
    GetEnumItems: (self: Enum_FramerateManagerMode) -> { EnumItem }
end

declare class Enum_FriendRequestEvent
    Issue: EnumItem
    Revoke: EnumItem
    Accept: EnumItem
    Deny: EnumItem
    GetEnumItems: (self: Enum_FriendRequestEvent) -> { EnumItem }
end

declare class Enum_FriendStatus
    Unknown: EnumItem
    NotFriend: EnumItem
    Friend: EnumItem
    FriendRequestSent: EnumItem
    FriendRequestReceived: EnumItem
    GetEnumItems: (self: Enum_FriendStatus) -> { EnumItem }
end

declare class Enum_FunctionalTestResult
    Passed: EnumItem
    Warning: EnumItem
    Error: EnumItem
    GetEnumItems: (self: Enum_FunctionalTestResult) -> { EnumItem }
end

declare class Enum_GameAvatarType
    R6: EnumItem
    R15: EnumItem
    PlayerChoice: EnumItem
    GetEnumItems: (self: Enum_GameAvatarType) -> { EnumItem }
end

declare class Enum_GearGenreSetting
    AllGenres: EnumItem
    MatchingGenreOnly: EnumItem
    GetEnumItems: (self: Enum_GearGenreSetting) -> { EnumItem }
end

declare class Enum_GearType
    MeleeWeapons: EnumItem
    RangedWeapons: EnumItem
    Explosives: EnumItem
    PowerUps: EnumItem
    NavigationEnhancers: EnumItem
    MusicalInstruments: EnumItem
    SocialItems: EnumItem
    BuildingTools: EnumItem
    Transport: EnumItem
    GetEnumItems: (self: Enum_GearType) -> { EnumItem }
end

declare class Enum_Genre
    All: EnumItem
    TownAndCity: EnumItem
    Fantasy: EnumItem
    SciFi: EnumItem
    Ninja: EnumItem
    Scary: EnumItem
    Pirate: EnumItem
    Adventure: EnumItem
    Sports: EnumItem
    Funny: EnumItem
    WildWest: EnumItem
    War: EnumItem
    SkatePark: EnumItem
    Tutorial: EnumItem
    GetEnumItems: (self: Enum_Genre) -> { EnumItem }
end

declare class Enum_GraphicsMode
    Automatic: EnumItem
    Direct3D11: EnumItem
    OpenGL: EnumItem
    Metal: EnumItem
    Vulkan: EnumItem
    NoGraphics: EnumItem
    GetEnumItems: (self: Enum_GraphicsMode) -> { EnumItem }
end

declare class Enum_GuiState
    Idle: EnumItem
    Hover: EnumItem
    Press: EnumItem
    GetEnumItems: (self: Enum_GuiState) -> { EnumItem }
end

declare class Enum_GuiType
    Core: EnumItem
    Custom: EnumItem
    CustomBillboards: EnumItem
    PlayerNameplates: EnumItem
    GetEnumItems: (self: Enum_GuiType) -> { EnumItem }
end

declare class Enum_HandlesStyle
    Resize: EnumItem
    Movement: EnumItem
    GetEnumItems: (self: Enum_HandlesStyle) -> { EnumItem }
end

declare class Enum_HighlightDepthMode
    AlwaysOnTop: EnumItem
    Occluded: EnumItem
    GetEnumItems: (self: Enum_HighlightDepthMode) -> { EnumItem }
end

declare class Enum_HorizontalAlignment
    Center: EnumItem
    Left: EnumItem
    Right: EnumItem
    GetEnumItems: (self: Enum_HorizontalAlignment) -> { EnumItem }
end

declare class Enum_HoverAnimateSpeed
    VerySlow: EnumItem
    Slow: EnumItem
    Medium: EnumItem
    Fast: EnumItem
    VeryFast: EnumItem
    GetEnumItems: (self: Enum_HoverAnimateSpeed) -> { EnumItem }
end

declare class Enum_HttpCachePolicy
    None: EnumItem
    Full: EnumItem
    DataOnly: EnumItem
    Default: EnumItem
    InternalRedirectRefresh: EnumItem
    GetEnumItems: (self: Enum_HttpCachePolicy) -> { EnumItem }
end

declare class Enum_HttpContentType
    ApplicationJson: EnumItem
    ApplicationXml: EnumItem
    ApplicationUrlEncoded: EnumItem
    TextPlain: EnumItem
    TextXml: EnumItem
    GetEnumItems: (self: Enum_HttpContentType) -> { EnumItem }
end

declare class Enum_HttpError
    OK: EnumItem
    InvalidUrl: EnumItem
    DnsResolve: EnumItem
    ConnectFail: EnumItem
    OutOfMemory: EnumItem
    TimedOut: EnumItem
    TooManyRedirects: EnumItem
    InvalidRedirect: EnumItem
    NetFail: EnumItem
    Aborted: EnumItem
    SslConnectFail: EnumItem
    SslVerificationFail: EnumItem
    Unknown: EnumItem
    GetEnumItems: (self: Enum_HttpError) -> { EnumItem }
end

declare class Enum_HttpRequestType
    Default: EnumItem
    MarketplaceService: EnumItem
    Players: EnumItem
    Chat: EnumItem
    Avatar: EnumItem
    Analytics: EnumItem
    Localization: EnumItem
    GetEnumItems: (self: Enum_HttpRequestType) -> { EnumItem }
end

declare class Enum_HumanoidCollisionType
    OuterBox: EnumItem
    InnerBox: EnumItem
    GetEnumItems: (self: Enum_HumanoidCollisionType) -> { EnumItem }
end

declare class Enum_HumanoidDisplayDistanceType
    Viewer: EnumItem
    Subject: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_HumanoidDisplayDistanceType) -> { EnumItem }
end

declare class Enum_HumanoidHealthDisplayType
    DisplayWhenDamaged: EnumItem
    AlwaysOn: EnumItem
    AlwaysOff: EnumItem
    GetEnumItems: (self: Enum_HumanoidHealthDisplayType) -> { EnumItem }
end

declare class Enum_HumanoidOnlySetCollisionsOnStateChange
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_HumanoidOnlySetCollisionsOnStateChange) -> { EnumItem }
end

declare class Enum_HumanoidRigType
    R6: EnumItem
    R15: EnumItem
    GetEnumItems: (self: Enum_HumanoidRigType) -> { EnumItem }
end

declare class Enum_HumanoidStateMachineMode
    Default: EnumItem
    Legacy: EnumItem
    NoStateMachine: EnumItem
    LuaStateMachine: EnumItem
    GetEnumItems: (self: Enum_HumanoidStateMachineMode) -> { EnumItem }
end

declare class Enum_HumanoidStateType
    FallingDown: EnumItem
    Running: EnumItem
    RunningNoPhysics: EnumItem
    Climbing: EnumItem
    StrafingNoPhysics: EnumItem
    Ragdoll: EnumItem
    GettingUp: EnumItem
    Jumping: EnumItem
    Landed: EnumItem
    Flying: EnumItem
    Freefall: EnumItem
    Seated: EnumItem
    PlatformStanding: EnumItem
    Dead: EnumItem
    Swimming: EnumItem
    Physics: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_HumanoidStateType) -> { EnumItem }
end

declare class Enum_IKCollisionsMode
    NoCollisions: EnumItem
    OtherMechanismsAnchored: EnumItem
    IncludeContactedMechanisms: EnumItem
    GetEnumItems: (self: Enum_IKCollisionsMode) -> { EnumItem }
end

declare class Enum_IKControlConstraintSupport
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_IKControlConstraintSupport) -> { EnumItem }
end

declare class Enum_IKControlType
    Transform: EnumItem
    Position: EnumItem
    Rotation: EnumItem
    LookAt: EnumItem
    GetEnumItems: (self: Enum_IKControlType) -> { EnumItem }
end

declare class Enum_IXPLoadingStatus
    None: EnumItem
    Pending: EnumItem
    Initialized: EnumItem
    ErrorTimedOut: EnumItem
    ErrorConnection: EnumItem
    ErrorJsonParse: EnumItem
    ErrorInvalidUser: EnumItem
    GetEnumItems: (self: Enum_IXPLoadingStatus) -> { EnumItem }
end

declare class Enum_InOut
    Edge: EnumItem
    Inset: EnumItem
    Center: EnumItem
    GetEnumItems: (self: Enum_InOut) -> { EnumItem }
end

declare class Enum_InfoType
    Asset: EnumItem
    Product: EnumItem
    GamePass: EnumItem
    Subscription: EnumItem
    Bundle: EnumItem
    GetEnumItems: (self: Enum_InfoType) -> { EnumItem }
end

declare class Enum_InitialDockState
    Top: EnumItem
    Bottom: EnumItem
    Left: EnumItem
    Right: EnumItem
    Float: EnumItem
    GetEnumItems: (self: Enum_InitialDockState) -> { EnumItem }
end

declare class Enum_InputType
    NoInput: EnumItem
    Constant: EnumItem
    Sin: EnumItem
    GetEnumItems: (self: Enum_InputType) -> { EnumItem }
end

declare class Enum_InterpolationThrottlingMode
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_InterpolationThrottlingMode) -> { EnumItem }
end

declare class Enum_JointCreationMode
    All: EnumItem
    Surface: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_JointCreationMode) -> { EnumItem }
end

declare class Enum_KeyCode
    Unknown: EnumItem
    Backspace: EnumItem
    Tab: EnumItem
    Clear: EnumItem
    Return: EnumItem
    Pause: EnumItem
    Escape: EnumItem
    Space: EnumItem
    QuotedDouble: EnumItem
    Hash: EnumItem
    Dollar: EnumItem
    Percent: EnumItem
    Ampersand: EnumItem
    Quote: EnumItem
    LeftParenthesis: EnumItem
    RightParenthesis: EnumItem
    Asterisk: EnumItem
    Plus: EnumItem
    Comma: EnumItem
    Minus: EnumItem
    Period: EnumItem
    Slash: EnumItem
    Zero: EnumItem
    One: EnumItem
    Two: EnumItem
    Three: EnumItem
    Four: EnumItem
    Five: EnumItem
    Six: EnumItem
    Seven: EnumItem
    Eight: EnumItem
    Nine: EnumItem
    Colon: EnumItem
    Semicolon: EnumItem
    LessThan: EnumItem
    Equals: EnumItem
    GreaterThan: EnumItem
    Question: EnumItem
    At: EnumItem
    LeftBracket: EnumItem
    BackSlash: EnumItem
    RightBracket: EnumItem
    Caret: EnumItem
    Underscore: EnumItem
    Backquote: EnumItem
    A: EnumItem
    B: EnumItem
    C: EnumItem
    D: EnumItem
    E: EnumItem
    F: EnumItem
    G: EnumItem
    H: EnumItem
    I: EnumItem
    J: EnumItem
    K: EnumItem
    L: EnumItem
    M: EnumItem
    N: EnumItem
    O: EnumItem
    P: EnumItem
    Q: EnumItem
    R: EnumItem
    S: EnumItem
    T: EnumItem
    U: EnumItem
    V: EnumItem
    W: EnumItem
    X: EnumItem
    Y: EnumItem
    Z: EnumItem
    LeftCurly: EnumItem
    Pipe: EnumItem
    RightCurly: EnumItem
    Tilde: EnumItem
    Delete: EnumItem
    KeypadZero: EnumItem
    KeypadOne: EnumItem
    KeypadTwo: EnumItem
    KeypadThree: EnumItem
    KeypadFour: EnumItem
    KeypadFive: EnumItem
    KeypadSix: EnumItem
    KeypadSeven: EnumItem
    KeypadEight: EnumItem
    KeypadNine: EnumItem
    KeypadPeriod: EnumItem
    KeypadDivide: EnumItem
    KeypadMultiply: EnumItem
    KeypadMinus: EnumItem
    KeypadPlus: EnumItem
    KeypadEnter: EnumItem
    KeypadEquals: EnumItem
    Up: EnumItem
    Down: EnumItem
    Right: EnumItem
    Left: EnumItem
    Insert: EnumItem
    Home: EnumItem
    End: EnumItem
    PageUp: EnumItem
    PageDown: EnumItem
    LeftShift: EnumItem
    RightShift: EnumItem
    LeftMeta: EnumItem
    RightMeta: EnumItem
    LeftAlt: EnumItem
    RightAlt: EnumItem
    LeftControl: EnumItem
    RightControl: EnumItem
    CapsLock: EnumItem
    NumLock: EnumItem
    ScrollLock: EnumItem
    LeftSuper: EnumItem
    RightSuper: EnumItem
    Mode: EnumItem
    Compose: EnumItem
    Help: EnumItem
    Print: EnumItem
    SysReq: EnumItem
    Break: EnumItem
    Menu: EnumItem
    Power: EnumItem
    Euro: EnumItem
    Undo: EnumItem
    F1: EnumItem
    F2: EnumItem
    F3: EnumItem
    F4: EnumItem
    F5: EnumItem
    F6: EnumItem
    F7: EnumItem
    F8: EnumItem
    F9: EnumItem
    F10: EnumItem
    F11: EnumItem
    F12: EnumItem
    F13: EnumItem
    F14: EnumItem
    F15: EnumItem
    World0: EnumItem
    World1: EnumItem
    World2: EnumItem
    World3: EnumItem
    World4: EnumItem
    World5: EnumItem
    World6: EnumItem
    World7: EnumItem
    World8: EnumItem
    World9: EnumItem
    World10: EnumItem
    World11: EnumItem
    World12: EnumItem
    World13: EnumItem
    World14: EnumItem
    World15: EnumItem
    World16: EnumItem
    World17: EnumItem
    World18: EnumItem
    World19: EnumItem
    World20: EnumItem
    World21: EnumItem
    World22: EnumItem
    World23: EnumItem
    World24: EnumItem
    World25: EnumItem
    World26: EnumItem
    World27: EnumItem
    World28: EnumItem
    World29: EnumItem
    World30: EnumItem
    World31: EnumItem
    World32: EnumItem
    World33: EnumItem
    World34: EnumItem
    World35: EnumItem
    World36: EnumItem
    World37: EnumItem
    World38: EnumItem
    World39: EnumItem
    World40: EnumItem
    World41: EnumItem
    World42: EnumItem
    World43: EnumItem
    World44: EnumItem
    World45: EnumItem
    World46: EnumItem
    World47: EnumItem
    World48: EnumItem
    World49: EnumItem
    World50: EnumItem
    World51: EnumItem
    World52: EnumItem
    World53: EnumItem
    World54: EnumItem
    World55: EnumItem
    World56: EnumItem
    World57: EnumItem
    World58: EnumItem
    World59: EnumItem
    World60: EnumItem
    World61: EnumItem
    World62: EnumItem
    World63: EnumItem
    World64: EnumItem
    World65: EnumItem
    World66: EnumItem
    World67: EnumItem
    World68: EnumItem
    World69: EnumItem
    World70: EnumItem
    World71: EnumItem
    World72: EnumItem
    World73: EnumItem
    World74: EnumItem
    World75: EnumItem
    World76: EnumItem
    World77: EnumItem
    World78: EnumItem
    World79: EnumItem
    World80: EnumItem
    World81: EnumItem
    World82: EnumItem
    World83: EnumItem
    World84: EnumItem
    World85: EnumItem
    World86: EnumItem
    World87: EnumItem
    World88: EnumItem
    World89: EnumItem
    World90: EnumItem
    World91: EnumItem
    World92: EnumItem
    World93: EnumItem
    World94: EnumItem
    World95: EnumItem
    ButtonX: EnumItem
    ButtonY: EnumItem
    ButtonA: EnumItem
    ButtonB: EnumItem
    ButtonR1: EnumItem
    ButtonL1: EnumItem
    ButtonR2: EnumItem
    ButtonL2: EnumItem
    ButtonR3: EnumItem
    ButtonL3: EnumItem
    ButtonStart: EnumItem
    ButtonSelect: EnumItem
    DPadLeft: EnumItem
    DPadRight: EnumItem
    DPadUp: EnumItem
    DPadDown: EnumItem
    Thumbstick1: EnumItem
    Thumbstick2: EnumItem
    GetEnumItems: (self: Enum_KeyCode) -> { EnumItem }
end

declare class Enum_KeyInterpolationMode
    Constant: EnumItem
    Linear: EnumItem
    Cubic: EnumItem
    GetEnumItems: (self: Enum_KeyInterpolationMode) -> { EnumItem }
end

declare class Enum_KeywordFilterType
    Include: EnumItem
    Exclude: EnumItem
    GetEnumItems: (self: Enum_KeywordFilterType) -> { EnumItem }
end

declare class Enum_Language
    Default: EnumItem
    GetEnumItems: (self: Enum_Language) -> { EnumItem }
end

declare class Enum_LeftRight
    Left: EnumItem
    Center: EnumItem
    Right: EnumItem
    GetEnumItems: (self: Enum_LeftRight) -> { EnumItem }
end

declare class Enum_Limb
    Head: EnumItem
    Torso: EnumItem
    LeftArm: EnumItem
    RightArm: EnumItem
    LeftLeg: EnumItem
    RightLeg: EnumItem
    Unknown: EnumItem
    GetEnumItems: (self: Enum_Limb) -> { EnumItem }
end

declare class Enum_LineJoinMode
    Round: EnumItem
    Bevel: EnumItem
    Miter: EnumItem
    GetEnumItems: (self: Enum_LineJoinMode) -> { EnumItem }
end

declare class Enum_ListDisplayMode
    Horizontal: EnumItem
    Vertical: EnumItem
    GetEnumItems: (self: Enum_ListDisplayMode) -> { EnumItem }
end

declare class Enum_ListenerType
    Camera: EnumItem
    CFrame: EnumItem
    ObjectPosition: EnumItem
    ObjectCFrame: EnumItem
    GetEnumItems: (self: Enum_ListenerType) -> { EnumItem }
end

declare class Enum_LoadCharacterLayeredClothing
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_LoadCharacterLayeredClothing) -> { EnumItem }
end

declare class Enum_LoadDynamicHeads
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_LoadDynamicHeads) -> { EnumItem }
end

declare class Enum_MarkupKind
    PlainText: EnumItem
    Markdown: EnumItem
    GetEnumItems: (self: Enum_MarkupKind) -> { EnumItem }
end

declare class Enum_Material
    Plastic: EnumItem
    Wood: EnumItem
    Slate: EnumItem
    Concrete: EnumItem
    CorrodedMetal: EnumItem
    DiamondPlate: EnumItem
    Foil: EnumItem
    Grass: EnumItem
    Ice: EnumItem
    Marble: EnumItem
    Granite: EnumItem
    Brick: EnumItem
    Pebble: EnumItem
    Sand: EnumItem
    Fabric: EnumItem
    SmoothPlastic: EnumItem
    Metal: EnumItem
    WoodPlanks: EnumItem
    Cobblestone: EnumItem
    Air: EnumItem
    Water: EnumItem
    Rock: EnumItem
    Glacier: EnumItem
    Snow: EnumItem
    Sandstone: EnumItem
    Mud: EnumItem
    Basalt: EnumItem
    Ground: EnumItem
    CrackedLava: EnumItem
    Neon: EnumItem
    Glass: EnumItem
    Asphalt: EnumItem
    LeafyGrass: EnumItem
    Salt: EnumItem
    Limestone: EnumItem
    Pavement: EnumItem
    ForceField: EnumItem
    Cardboard: EnumItem
    Carpet: EnumItem
    CeramicTiles: EnumItem
    ClayRoofTiles: EnumItem
    RoofShingles: EnumItem
    Leather: EnumItem
    Plaster: EnumItem
    Rubber: EnumItem
    GetEnumItems: (self: Enum_Material) -> { EnumItem }
end

declare class Enum_MaterialPattern
    Regular: EnumItem
    Organic: EnumItem
    GetEnumItems: (self: Enum_MaterialPattern) -> { EnumItem }
end

declare class Enum_MembershipType
    None: EnumItem
    BuildersClub: EnumItem
    TurboBuildersClub: EnumItem
    OutrageousBuildersClub: EnumItem
    Premium: EnumItem
    GetEnumItems: (self: Enum_MembershipType) -> { EnumItem }
end

declare class Enum_MeshPartDetailLevel
    DistanceBased: EnumItem
    Level00: EnumItem
    Level01: EnumItem
    Level02: EnumItem
    Level03: EnumItem
    Level04: EnumItem
    GetEnumItems: (self: Enum_MeshPartDetailLevel) -> { EnumItem }
end

declare class Enum_MeshPartHeadsAndAccessories
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_MeshPartHeadsAndAccessories) -> { EnumItem }
end

declare class Enum_MeshScaleUnit
    Stud: EnumItem
    Meter: EnumItem
    CM: EnumItem
    MM: EnumItem
    Foot: EnumItem
    Inch: EnumItem
    GetEnumItems: (self: Enum_MeshScaleUnit) -> { EnumItem }
end

declare class Enum_MeshType
    Head: EnumItem
    Torso: EnumItem
    Wedge: EnumItem
    Prism: EnumItem
    Pyramid: EnumItem
    ParallelRamp: EnumItem
    RightAngleRamp: EnumItem
    CornerWedge: EnumItem
    Brick: EnumItem
    Sphere: EnumItem
    Cylinder: EnumItem
    FileMesh: EnumItem
    GetEnumItems: (self: Enum_MeshType) -> { EnumItem }
end

declare class Enum_MessageType
    MessageOutput: EnumItem
    MessageInfo: EnumItem
    MessageWarning: EnumItem
    MessageError: EnumItem
    GetEnumItems: (self: Enum_MessageType) -> { EnumItem }
end

declare class Enum_ModelLevelOfDetail
    Automatic: EnumItem
    StreamingMesh: EnumItem
    Disabled: EnumItem
    GetEnumItems: (self: Enum_ModelLevelOfDetail) -> { EnumItem }
end

declare class Enum_ModelStreamingBehavior
    Default: EnumItem
    Legacy: EnumItem
    Improved: EnumItem
    GetEnumItems: (self: Enum_ModelStreamingBehavior) -> { EnumItem }
end

declare class Enum_ModelStreamingMode
    Default: EnumItem
    Atomic: EnumItem
    Persistent: EnumItem
    PersistentPerPlayer: EnumItem
    Nonatomic: EnumItem
    GetEnumItems: (self: Enum_ModelStreamingMode) -> { EnumItem }
end

declare class Enum_ModifierKey
    Alt: EnumItem
    Ctrl: EnumItem
    Meta: EnumItem
    Shift: EnumItem
    GetEnumItems: (self: Enum_ModifierKey) -> { EnumItem }
end

declare class Enum_MouseBehavior
    Default: EnumItem
    LockCenter: EnumItem
    LockCurrentPosition: EnumItem
    GetEnumItems: (self: Enum_MouseBehavior) -> { EnumItem }
end

declare class Enum_MoveState
    Stopped: EnumItem
    Coasting: EnumItem
    Pushing: EnumItem
    Stopping: EnumItem
    AirFree: EnumItem
    GetEnumItems: (self: Enum_MoveState) -> { EnumItem }
end

declare class Enum_MuteState
    Unmuted: EnumItem
    Muted: EnumItem
    GetEnumItems: (self: Enum_MuteState) -> { EnumItem }
end

declare class Enum_NameOcclusion
    OccludeAll: EnumItem
    EnemyOcclusion: EnumItem
    NoOcclusion: EnumItem
    GetEnumItems: (self: Enum_NameOcclusion) -> { EnumItem }
end

declare class Enum_NetworkOwnership
    Automatic: EnumItem
    Manual: EnumItem
    OnContact: EnumItem
    GetEnumItems: (self: Enum_NetworkOwnership) -> { EnumItem }
end

declare class Enum_NormalId
    Top: EnumItem
    Bottom: EnumItem
    Back: EnumItem
    Front: EnumItem
    Right: EnumItem
    Left: EnumItem
    GetEnumItems: (self: Enum_NormalId) -> { EnumItem }
end

declare class Enum_OrientationAlignmentMode
    OneAttachment: EnumItem
    TwoAttachment: EnumItem
    GetEnumItems: (self: Enum_OrientationAlignmentMode) -> { EnumItem }
end

declare class Enum_OutfitSource
    All: EnumItem
    Created: EnumItem
    Purchased: EnumItem
    GetEnumItems: (self: Enum_OutfitSource) -> { EnumItem }
end

declare class Enum_OutfitType
    All: EnumItem
    Avatar: EnumItem
    DynamicHead: EnumItem
    GetEnumItems: (self: Enum_OutfitType) -> { EnumItem }
end

declare class Enum_OutputLayoutMode
    Horizontal: EnumItem
    Vertical: EnumItem
    GetEnumItems: (self: Enum_OutputLayoutMode) -> { EnumItem }
end

declare class Enum_OverrideMouseIconBehavior
    None: EnumItem
    ForceShow: EnumItem
    ForceHide: EnumItem
    GetEnumItems: (self: Enum_OverrideMouseIconBehavior) -> { EnumItem }
end

declare class Enum_PackagePermission
    None: EnumItem
    NoAccess: EnumItem
    Revoked: EnumItem
    UseView: EnumItem
    Edit: EnumItem
    Own: EnumItem
    GetEnumItems: (self: Enum_PackagePermission) -> { EnumItem }
end

declare class Enum_PartType
    Ball: EnumItem
    Block: EnumItem
    Cylinder: EnumItem
    Wedge: EnumItem
    CornerWedge: EnumItem
    GetEnumItems: (self: Enum_PartType) -> { EnumItem }
end

declare class Enum_ParticleEmitterShape
    Box: EnumItem
    Sphere: EnumItem
    Cylinder: EnumItem
    Disc: EnumItem
    GetEnumItems: (self: Enum_ParticleEmitterShape) -> { EnumItem }
end

declare class Enum_ParticleEmitterShapeInOut
    Outward: EnumItem
    Inward: EnumItem
    InAndOut: EnumItem
    GetEnumItems: (self: Enum_ParticleEmitterShapeInOut) -> { EnumItem }
end

declare class Enum_ParticleEmitterShapeStyle
    Volume: EnumItem
    Surface: EnumItem
    GetEnumItems: (self: Enum_ParticleEmitterShapeStyle) -> { EnumItem }
end

declare class Enum_ParticleFlipbookLayout
    None: EnumItem
    Grid2x2: EnumItem
    Grid4x4: EnumItem
    Grid8x8: EnumItem
    GetEnumItems: (self: Enum_ParticleFlipbookLayout) -> { EnumItem }
end

declare class Enum_ParticleFlipbookMode
    Loop: EnumItem
    OneShot: EnumItem
    PingPong: EnumItem
    Random: EnumItem
    GetEnumItems: (self: Enum_ParticleFlipbookMode) -> { EnumItem }
end

declare class Enum_ParticleFlipbookTextureCompatible
    NotCompatible: EnumItem
    Compatible: EnumItem
    Unknown: EnumItem
    GetEnumItems: (self: Enum_ParticleFlipbookTextureCompatible) -> { EnumItem }
end

declare class Enum_ParticleOrientation
    FacingCamera: EnumItem
    FacingCameraWorldUp: EnumItem
    VelocityParallel: EnumItem
    VelocityPerpendicular: EnumItem
    GetEnumItems: (self: Enum_ParticleOrientation) -> { EnumItem }
end

declare class Enum_PathStatus
    Success: EnumItem
    ClosestNoPath: EnumItem
    ClosestOutOfRange: EnumItem
    FailStartNotEmpty: EnumItem
    FailFinishNotEmpty: EnumItem
    NoPath: EnumItem
    GetEnumItems: (self: Enum_PathStatus) -> { EnumItem }
end

declare class Enum_PathWaypointAction
    Walk: EnumItem
    Jump: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_PathWaypointAction) -> { EnumItem }
end

declare class Enum_PermissionLevelShown
    Game: EnumItem
    RobloxGame: EnumItem
    RobloxScript: EnumItem
    Studio: EnumItem
    Roblox: EnumItem
    GetEnumItems: (self: Enum_PermissionLevelShown) -> { EnumItem }
end

declare class Enum_PhysicsSimulationRate
    Fixed240Hz: EnumItem
    Fixed120Hz: EnumItem
    Fixed60Hz: EnumItem
    GetEnumItems: (self: Enum_PhysicsSimulationRate) -> { EnumItem }
end

declare class Enum_PhysicsSteppingMethod
    Default: EnumItem
    Fixed: EnumItem
    Adaptive: EnumItem
    GetEnumItems: (self: Enum_PhysicsSteppingMethod) -> { EnumItem }
end

declare class Enum_Platform
    Windows: EnumItem
    OSX: EnumItem
    IOS: EnumItem
    Android: EnumItem
    XBoxOne: EnumItem
    PS4: EnumItem
    PS3: EnumItem
    XBox360: EnumItem
    WiiU: EnumItem
    NX: EnumItem
    Ouya: EnumItem
    AndroidTV: EnumItem
    Chromecast: EnumItem
    Linux: EnumItem
    SteamOS: EnumItem
    WebOS: EnumItem
    DOS: EnumItem
    BeOS: EnumItem
    UWP: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_Platform) -> { EnumItem }
end

declare class Enum_PlaybackState
    Begin: EnumItem
    Delayed: EnumItem
    Playing: EnumItem
    Paused: EnumItem
    Completed: EnumItem
    Cancelled: EnumItem
    GetEnumItems: (self: Enum_PlaybackState) -> { EnumItem }
end

declare class Enum_PlayerActions
    CharacterForward: EnumItem
    CharacterBackward: EnumItem
    CharacterLeft: EnumItem
    CharacterRight: EnumItem
    CharacterJump: EnumItem
    GetEnumItems: (self: Enum_PlayerActions) -> { EnumItem }
end

declare class Enum_PlayerChatType
    All: EnumItem
    Team: EnumItem
    Whisper: EnumItem
    GetEnumItems: (self: Enum_PlayerChatType) -> { EnumItem }
end

declare class Enum_PoseEasingDirection
    Out: EnumItem
    InOut: EnumItem
    In: EnumItem
    GetEnumItems: (self: Enum_PoseEasingDirection) -> { EnumItem }
end

declare class Enum_PoseEasingStyle
    Linear: EnumItem
    Constant: EnumItem
    Elastic: EnumItem
    Cubic: EnumItem
    Bounce: EnumItem
    GetEnumItems: (self: Enum_PoseEasingStyle) -> { EnumItem }
end

declare class Enum_PositionAlignmentMode
    OneAttachment: EnumItem
    TwoAttachment: EnumItem
    GetEnumItems: (self: Enum_PositionAlignmentMode) -> { EnumItem }
end

declare class Enum_PrivilegeType
    Owner: EnumItem
    Admin: EnumItem
    Member: EnumItem
    Visitor: EnumItem
    Banned: EnumItem
    GetEnumItems: (self: Enum_PrivilegeType) -> { EnumItem }
end

declare class Enum_ProductLocationRestriction
    AvatarShop: EnumItem
    AllowedGames: EnumItem
    AllGames: EnumItem
    GetEnumItems: (self: Enum_ProductLocationRestriction) -> { EnumItem }
end

declare class Enum_ProductPurchaseDecision
    NotProcessedYet: EnumItem
    PurchaseGranted: EnumItem
    GetEnumItems: (self: Enum_ProductPurchaseDecision) -> { EnumItem }
end

declare class Enum_PromptCreateAssetResult
    Success: EnumItem
    PermissionDenied: EnumItem
    Timeout: EnumItem
    UploadFailed: EnumItem
    NoUserInput: EnumItem
    UnknownFailure: EnumItem
    GetEnumItems: (self: Enum_PromptCreateAssetResult) -> { EnumItem }
end

declare class Enum_PromptPublishAssetResult
    Success: EnumItem
    PermissionDenied: EnumItem
    Timeout: EnumItem
    UploadFailed: EnumItem
    NoUserInput: EnumItem
    UnknownFailure: EnumItem
    GetEnumItems: (self: Enum_PromptPublishAssetResult) -> { EnumItem }
end

declare class Enum_PropertyStatus
    Ok: EnumItem
    Warning: EnumItem
    Error: EnumItem
    GetEnumItems: (self: Enum_PropertyStatus) -> { EnumItem }
end

declare class Enum_ProximityPromptExclusivity
    OnePerButton: EnumItem
    OneGlobally: EnumItem
    AlwaysShow: EnumItem
    GetEnumItems: (self: Enum_ProximityPromptExclusivity) -> { EnumItem }
end

declare class Enum_ProximityPromptInputType
    Keyboard: EnumItem
    Gamepad: EnumItem
    Touch: EnumItem
    GetEnumItems: (self: Enum_ProximityPromptInputType) -> { EnumItem }
end

declare class Enum_ProximityPromptStyle
    Default: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_ProximityPromptStyle) -> { EnumItem }
end

declare class Enum_QualityLevel
    Automatic: EnumItem
    Level01: EnumItem
    Level02: EnumItem
    Level03: EnumItem
    Level04: EnumItem
    Level05: EnumItem
    Level06: EnumItem
    Level07: EnumItem
    Level08: EnumItem
    Level09: EnumItem
    Level10: EnumItem
    Level11: EnumItem
    Level12: EnumItem
    Level13: EnumItem
    Level14: EnumItem
    Level15: EnumItem
    Level16: EnumItem
    Level17: EnumItem
    Level18: EnumItem
    Level19: EnumItem
    Level20: EnumItem
    Level21: EnumItem
    GetEnumItems: (self: Enum_QualityLevel) -> { EnumItem }
end

declare class Enum_R15CollisionType
    OuterBox: EnumItem
    InnerBox: EnumItem
    GetEnumItems: (self: Enum_R15CollisionType) -> { EnumItem }
end

declare class Enum_RaycastFilterType
    Exclude: EnumItem
    Include: EnumItem
    GetEnumItems: (self: Enum_RaycastFilterType) -> { EnumItem }
end

declare class Enum_RejectCharacterDeletions
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_RejectCharacterDeletions) -> { EnumItem }
end

declare class Enum_RenderFidelity
    Automatic: EnumItem
    Precise: EnumItem
    Performance: EnumItem
    GetEnumItems: (self: Enum_RenderFidelity) -> { EnumItem }
end

declare class Enum_RenderPriority
    First: EnumItem
    Input: EnumItem
    Camera: EnumItem
    Character: EnumItem
    Last: EnumItem
    GetEnumItems: (self: Enum_RenderPriority) -> { EnumItem }
end

declare class Enum_RenderingTestComparisonMethod
    psnr: EnumItem
    diff: EnumItem
    GetEnumItems: (self: Enum_RenderingTestComparisonMethod) -> { EnumItem }
end

declare class Enum_ReplicateInstanceDestroySetting
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_ReplicateInstanceDestroySetting) -> { EnumItem }
end

declare class Enum_ResamplerMode
    Default: EnumItem
    Pixelated: EnumItem
    GetEnumItems: (self: Enum_ResamplerMode) -> { EnumItem }
end

declare class Enum_ReservedHighlightId
    Standard: EnumItem
    Selection: EnumItem
    Hover: EnumItem
    Active: EnumItem
    GetEnumItems: (self: Enum_ReservedHighlightId) -> { EnumItem }
end

declare class Enum_RestPose
    Default: EnumItem
    RotationsReset: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_RestPose) -> { EnumItem }
end

declare class Enum_ReturnKeyType
    Default: EnumItem
    Done: EnumItem
    Go: EnumItem
    Next: EnumItem
    Search: EnumItem
    Send: EnumItem
    GetEnumItems: (self: Enum_ReturnKeyType) -> { EnumItem }
end

declare class Enum_ReverbType
    NoReverb: EnumItem
    GenericReverb: EnumItem
    PaddedCell: EnumItem
    Room: EnumItem
    Bathroom: EnumItem
    LivingRoom: EnumItem
    StoneRoom: EnumItem
    Auditorium: EnumItem
    ConcertHall: EnumItem
    Cave: EnumItem
    Arena: EnumItem
    Hangar: EnumItem
    CarpettedHallway: EnumItem
    Hallway: EnumItem
    StoneCorridor: EnumItem
    Alley: EnumItem
    Forest: EnumItem
    City: EnumItem
    Mountains: EnumItem
    Quarry: EnumItem
    Plain: EnumItem
    ParkingLot: EnumItem
    SewerPipe: EnumItem
    UnderWater: EnumItem
    GetEnumItems: (self: Enum_ReverbType) -> { EnumItem }
end

declare class Enum_RibbonTool
    Select: EnumItem
    Scale: EnumItem
    Rotate: EnumItem
    Move: EnumItem
    Transform: EnumItem
    ColorPicker: EnumItem
    MaterialPicker: EnumItem
    Group: EnumItem
    Ungroup: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_RibbonTool) -> { EnumItem }
end

declare class Enum_RigScale
    Default: EnumItem
    Rthro: EnumItem
    RthroNarrow: EnumItem
    GetEnumItems: (self: Enum_RigScale) -> { EnumItem }
end

declare class Enum_RigType
    R15: EnumItem
    Custom: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_RigType) -> { EnumItem }
end

declare class Enum_RollOffMode
    Inverse: EnumItem
    Linear: EnumItem
    InverseTapered: EnumItem
    LinearSquare: EnumItem
    GetEnumItems: (self: Enum_RollOffMode) -> { EnumItem }
end

declare class Enum_RotationOrder
    XYZ: EnumItem
    XZY: EnumItem
    YZX: EnumItem
    YXZ: EnumItem
    ZXY: EnumItem
    ZYX: EnumItem
    GetEnumItems: (self: Enum_RotationOrder) -> { EnumItem }
end

declare class Enum_RotationType
    MovementRelative: EnumItem
    CameraRelative: EnumItem
    GetEnumItems: (self: Enum_RotationType) -> { EnumItem }
end

declare class Enum_RtlTextSupport
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_RtlTextSupport) -> { EnumItem }
end

declare class Enum_RunContext
    Legacy: EnumItem
    Server: EnumItem
    Client: EnumItem
    Plugin: EnumItem
    GetEnumItems: (self: Enum_RunContext) -> { EnumItem }
end

declare class Enum_RuntimeUndoBehavior
    Aggregate: EnumItem
    Snapshot: EnumItem
    Hybrid: EnumItem
    GetEnumItems: (self: Enum_RuntimeUndoBehavior) -> { EnumItem }
end

declare class Enum_SafeAreaCompatibility
    None: EnumItem
    FullscreenExtension: EnumItem
    GetEnumItems: (self: Enum_SafeAreaCompatibility) -> { EnumItem }
end

declare class Enum_SalesTypeFilter
    All: EnumItem
    Collectibles: EnumItem
    Premium: EnumItem
    GetEnumItems: (self: Enum_SalesTypeFilter) -> { EnumItem }
end

declare class Enum_SaveAvatarThumbnailCustomizationFailure
    BadThumbnailType: EnumItem
    BadYRotDeg: EnumItem
    BadFieldOfViewDeg: EnumItem
    BadDistanceScale: EnumItem
    Other: EnumItem
    GetEnumItems: (self: Enum_SaveAvatarThumbnailCustomizationFailure) -> { EnumItem }
end

declare class Enum_SaveFilter
    SaveAll: EnumItem
    SaveWorld: EnumItem
    SaveGame: EnumItem
    GetEnumItems: (self: Enum_SaveFilter) -> { EnumItem }
end

declare class Enum_SavedQualitySetting
    Automatic: EnumItem
    QualityLevel1: EnumItem
    QualityLevel2: EnumItem
    QualityLevel3: EnumItem
    QualityLevel4: EnumItem
    QualityLevel5: EnumItem
    QualityLevel6: EnumItem
    QualityLevel7: EnumItem
    QualityLevel8: EnumItem
    QualityLevel9: EnumItem
    QualityLevel10: EnumItem
    GetEnumItems: (self: Enum_SavedQualitySetting) -> { EnumItem }
end

declare class Enum_ScaleType
    Stretch: EnumItem
    Slice: EnumItem
    Tile: EnumItem
    Fit: EnumItem
    Crop: EnumItem
    GetEnumItems: (self: Enum_ScaleType) -> { EnumItem }
end

declare class Enum_ScopeCheckResult
    ConsentAccepted: EnumItem
    InvalidScopes: EnumItem
    Timeout: EnumItem
    NoUserInput: EnumItem
    BackendError: EnumItem
    UnexpectedError: EnumItem
    InvalidArgument: EnumItem
    ConsentDenied: EnumItem
    GetEnumItems: (self: Enum_ScopeCheckResult) -> { EnumItem }
end

declare class Enum_ScreenInsets
    None: EnumItem
    DeviceSafeInsets: EnumItem
    CoreUISafeInsets: EnumItem
    GetEnumItems: (self: Enum_ScreenInsets) -> { EnumItem }
end

declare class Enum_ScreenOrientation
    LandscapeLeft: EnumItem
    LandscapeRight: EnumItem
    LandscapeSensor: EnumItem
    Portrait: EnumItem
    Sensor: EnumItem
    GetEnumItems: (self: Enum_ScreenOrientation) -> { EnumItem }
end

declare class Enum_ScrollBarInset
    None: EnumItem
    ScrollBar: EnumItem
    Always: EnumItem
    GetEnumItems: (self: Enum_ScrollBarInset) -> { EnumItem }
end

declare class Enum_ScrollingDirection
    X: EnumItem
    Y: EnumItem
    XY: EnumItem
    GetEnumItems: (self: Enum_ScrollingDirection) -> { EnumItem }
end

declare class Enum_SelectionBehavior
    Escape: EnumItem
    Stop: EnumItem
    GetEnumItems: (self: Enum_SelectionBehavior) -> { EnumItem }
end

declare class Enum_SelectionRenderMode
    Outlines: EnumItem
    BoundingBoxes: EnumItem
    Both: EnumItem
    GetEnumItems: (self: Enum_SelectionRenderMode) -> { EnumItem }
end

declare class Enum_SelfViewPosition
    LastPosition: EnumItem
    TopLeft: EnumItem
    TopRight: EnumItem
    BottomLeft: EnumItem
    BottomRight: EnumItem
    GetEnumItems: (self: Enum_SelfViewPosition) -> { EnumItem }
end

declare class Enum_SensorMode
    Floor: EnumItem
    Ladder: EnumItem
    GetEnumItems: (self: Enum_SensorMode) -> { EnumItem }
end

declare class Enum_SensorUpdateType
    OnRead: EnumItem
    Manual: EnumItem
    GetEnumItems: (self: Enum_SensorUpdateType) -> { EnumItem }
end

declare class Enum_ServerAudioBehavior
    Enabled: EnumItem
    Muted: EnumItem
    OnlineGame: EnumItem
    GetEnumItems: (self: Enum_ServerAudioBehavior) -> { EnumItem }
end

declare class Enum_ServiceVisibility
    Always: EnumItem
    Off: EnumItem
    WithChildren: EnumItem
    GetEnumItems: (self: Enum_ServiceVisibility) -> { EnumItem }
end

declare class Enum_Severity
    Error: EnumItem
    Warning: EnumItem
    Information: EnumItem
    Hint: EnumItem
    GetEnumItems: (self: Enum_Severity) -> { EnumItem }
end

declare class Enum_SignalBehavior
    Default: EnumItem
    Immediate: EnumItem
    Deferred: EnumItem
    AncestryDeferred: EnumItem
    GetEnumItems: (self: Enum_SignalBehavior) -> { EnumItem }
end

declare class Enum_SizeConstraint
    RelativeXY: EnumItem
    RelativeXX: EnumItem
    RelativeYY: EnumItem
    GetEnumItems: (self: Enum_SizeConstraint) -> { EnumItem }
end

declare class Enum_SolverConvergenceVisualizationMode
    Disabled: EnumItem
    PerIsland: EnumItem
    PerEdge: EnumItem
    GetEnumItems: (self: Enum_SolverConvergenceVisualizationMode) -> { EnumItem }
end

declare class Enum_SortDirection
    Ascending: EnumItem
    Descending: EnumItem
    GetEnumItems: (self: Enum_SortDirection) -> { EnumItem }
end

declare class Enum_SortOrder
    LayoutOrder: EnumItem
    Name: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_SortOrder) -> { EnumItem }
end

declare class Enum_SpecialKey
    Insert: EnumItem
    Home: EnumItem
    End: EnumItem
    PageUp: EnumItem
    PageDown: EnumItem
    ChatHotkey: EnumItem
    GetEnumItems: (self: Enum_SpecialKey) -> { EnumItem }
end

declare class Enum_StartCorner
    TopLeft: EnumItem
    TopRight: EnumItem
    BottomLeft: EnumItem
    BottomRight: EnumItem
    GetEnumItems: (self: Enum_StartCorner) -> { EnumItem }
end

declare class Enum_Status
    Poison: EnumItem
    Confusion: EnumItem
    GetEnumItems: (self: Enum_Status) -> { EnumItem }
end

declare class Enum_StreamOutBehavior
    Default: EnumItem
    LowMemory: EnumItem
    Opportunistic: EnumItem
    GetEnumItems: (self: Enum_StreamOutBehavior) -> { EnumItem }
end

declare class Enum_StreamingIntegrityMode
    Default: EnumItem
    Disabled: EnumItem
    MinimumRadiusPause: EnumItem
    PauseOutsideLoadedArea: EnumItem
    GetEnumItems: (self: Enum_StreamingIntegrityMode) -> { EnumItem }
end

declare class Enum_StreamingPauseMode
    Default: EnumItem
    Disabled: EnumItem
    ClientPhysicsPause: EnumItem
    GetEnumItems: (self: Enum_StreamingPauseMode) -> { EnumItem }
end

declare class Enum_StudioCloseMode
    None: EnumItem
    CloseStudio: EnumItem
    CloseDoc: EnumItem
    GetEnumItems: (self: Enum_StudioCloseMode) -> { EnumItem }
end

declare class Enum_StudioDataModelType
    Edit: EnumItem
    PlayClient: EnumItem
    PlayServer: EnumItem
    Standalone: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_StudioDataModelType) -> { EnumItem }
end

declare class Enum_StudioScriptEditorColorCategories
    Default: EnumItem
    Operator: EnumItem
    Number: EnumItem
    String: EnumItem
    Comment: EnumItem
    Keyword: EnumItem
    Builtin: EnumItem
    Method: EnumItem
    Property: EnumItem
    Nil: EnumItem
    Bool: EnumItem
    Function: EnumItem
    Local: EnumItem
    Self: EnumItem
    LuauKeyword: EnumItem
    FunctionName: EnumItem
    TODO: EnumItem
    Background: EnumItem
    SelectionText: EnumItem
    SelectionBackground: EnumItem
    FindSelectionBackground: EnumItem
    MatchingWordBackground: EnumItem
    Warning: EnumItem
    Error: EnumItem
    Info: EnumItem
    Hint: EnumItem
    Whitespace: EnumItem
    ActiveLine: EnumItem
    DebuggerCurrentLine: EnumItem
    DebuggerErrorLine: EnumItem
    Ruler: EnumItem
    Bracket: EnumItem
    MenuPrimaryText: EnumItem
    MenuSecondaryText: EnumItem
    MenuSelectedText: EnumItem
    MenuBackground: EnumItem
    MenuSelectedBackground: EnumItem
    MenuScrollbarBackground: EnumItem
    MenuScrollbarHandle: EnumItem
    MenuBorder: EnumItem
    DocViewCodeBackground: EnumItem
    AICOOverlayText: EnumItem
    AICOOverlayButtonBackground: EnumItem
    AICOOverlayButtonBackgroundHover: EnumItem
    AICOOverlayButtonBackgroundPressed: EnumItem
    IndentationRuler: EnumItem
    GetEnumItems: (self: Enum_StudioScriptEditorColorCategories) -> { EnumItem }
end

declare class Enum_StudioScriptEditorColorPresets
    RobloxDefault: EnumItem
    Extra1: EnumItem
    Extra2: EnumItem
    Custom: EnumItem
    GetEnumItems: (self: Enum_StudioScriptEditorColorPresets) -> { EnumItem }
end

declare class Enum_StudioStyleGuideColor
    MainBackground: EnumItem
    Titlebar: EnumItem
    Dropdown: EnumItem
    Tooltip: EnumItem
    Notification: EnumItem
    ScrollBar: EnumItem
    ScrollBarBackground: EnumItem
    TabBar: EnumItem
    Tab: EnumItem
    FilterButtonDefault: EnumItem
    FilterButtonHover: EnumItem
    FilterButtonChecked: EnumItem
    FilterButtonAccent: EnumItem
    FilterButtonBorder: EnumItem
    FilterButtonBorderAlt: EnumItem
    RibbonTab: EnumItem
    RibbonTabTopBar: EnumItem
    Button: EnumItem
    MainButton: EnumItem
    RibbonButton: EnumItem
    ViewPortBackground: EnumItem
    InputFieldBackground: EnumItem
    Item: EnumItem
    TableItem: EnumItem
    CategoryItem: EnumItem
    GameSettingsTableItem: EnumItem
    GameSettingsTooltip: EnumItem
    EmulatorBar: EnumItem
    EmulatorDropDown: EnumItem
    ColorPickerFrame: EnumItem
    CurrentMarker: EnumItem
    Border: EnumItem
    DropShadow: EnumItem
    Shadow: EnumItem
    Light: EnumItem
    Dark: EnumItem
    Mid: EnumItem
    MainText: EnumItem
    SubText: EnumItem
    TitlebarText: EnumItem
    BrightText: EnumItem
    DimmedText: EnumItem
    LinkText: EnumItem
    WarningText: EnumItem
    ErrorText: EnumItem
    InfoText: EnumItem
    SensitiveText: EnumItem
    ScriptSideWidget: EnumItem
    ScriptBackground: EnumItem
    ScriptText: EnumItem
    ScriptSelectionText: EnumItem
    ScriptSelectionBackground: EnumItem
    ScriptFindSelectionBackground: EnumItem
    ScriptMatchingWordSelectionBackground: EnumItem
    ScriptOperator: EnumItem
    ScriptNumber: EnumItem
    ScriptString: EnumItem
    ScriptComment: EnumItem
    ScriptKeyword: EnumItem
    ScriptBuiltInFunction: EnumItem
    ScriptWarning: EnumItem
    ScriptError: EnumItem
    ScriptInformation: EnumItem
    ScriptHint: EnumItem
    ScriptWhitespace: EnumItem
    ScriptRuler: EnumItem
    DocViewCodeBackground: EnumItem
    DebuggerCurrentLine: EnumItem
    DebuggerErrorLine: EnumItem
    ScriptEditorCurrentLine: EnumItem
    DiffFilePathText: EnumItem
    DiffTextHunkInfo: EnumItem
    DiffTextNoChange: EnumItem
    DiffTextAddition: EnumItem
    DiffTextDeletion: EnumItem
    DiffTextSeparatorBackground: EnumItem
    DiffTextNoChangeBackground: EnumItem
    DiffTextAdditionBackground: EnumItem
    DiffTextDeletionBackground: EnumItem
    DiffLineNum: EnumItem
    DiffLineNumSeparatorBackground: EnumItem
    DiffLineNumNoChangeBackground: EnumItem
    DiffLineNumAdditionBackground: EnumItem
    DiffLineNumDeletionBackground: EnumItem
    DiffFilePathBackground: EnumItem
    DiffFilePathBorder: EnumItem
    ChatIncomingBgColor: EnumItem
    ChatIncomingTextColor: EnumItem
    ChatOutgoingBgColor: EnumItem
    ChatOutgoingTextColor: EnumItem
    ChatModeratedMessageColor: EnumItem
    Separator: EnumItem
    ButtonBorder: EnumItem
    ButtonText: EnumItem
    InputFieldBorder: EnumItem
    CheckedFieldBackground: EnumItem
    CheckedFieldBorder: EnumItem
    CheckedFieldIndicator: EnumItem
    HeaderSection: EnumItem
    Midlight: EnumItem
    StatusBar: EnumItem
    DialogButton: EnumItem
    DialogButtonText: EnumItem
    DialogButtonBorder: EnumItem
    DialogMainButton: EnumItem
    DialogMainButtonText: EnumItem
    InfoBarWarningBackground: EnumItem
    InfoBarWarningText: EnumItem
    ScriptMethod: EnumItem
    ScriptProperty: EnumItem
    ScriptNil: EnumItem
    ScriptBool: EnumItem
    ScriptFunction: EnumItem
    ScriptLocal: EnumItem
    ScriptSelf: EnumItem
    ScriptLuauKeyword: EnumItem
    ScriptFunctionName: EnumItem
    ScriptTodo: EnumItem
    ScriptBracket: EnumItem
    AICOOverlayText: EnumItem
    AICOOverlayButtonBackground: EnumItem
    AICOOverlayButtonBackgroundHover: EnumItem
    AICOOverlayButtonBackgroundPressed: EnumItem
    AttributeCog: EnumItem
    GetEnumItems: (self: Enum_StudioStyleGuideColor) -> { EnumItem }
end

declare class Enum_StudioStyleGuideModifier
    Default: EnumItem
    Selected: EnumItem
    Pressed: EnumItem
    Disabled: EnumItem
    Hover: EnumItem
    GetEnumItems: (self: Enum_StudioStyleGuideModifier) -> { EnumItem }
end

declare class Enum_Style
    AlternatingSupports: EnumItem
    BridgeStyleSupports: EnumItem
    NoSupports: EnumItem
    GetEnumItems: (self: Enum_Style) -> { EnumItem }
end

declare class Enum_SurfaceConstraint
    None: EnumItem
    Hinge: EnumItem
    SteppingMotor: EnumItem
    Motor: EnumItem
    GetEnumItems: (self: Enum_SurfaceConstraint) -> { EnumItem }
end

declare class Enum_SurfaceGuiShape
    Flat: EnumItem
    CurvedHorizontally: EnumItem
    GetEnumItems: (self: Enum_SurfaceGuiShape) -> { EnumItem }
end

declare class Enum_SurfaceGuiSizingMode
    FixedSize: EnumItem
    PixelsPerStud: EnumItem
    GetEnumItems: (self: Enum_SurfaceGuiSizingMode) -> { EnumItem }
end

declare class Enum_SurfaceType
    Smooth: EnumItem
    Glue: EnumItem
    Weld: EnumItem
    Studs: EnumItem
    Inlet: EnumItem
    Universal: EnumItem
    Hinge: EnumItem
    Motor: EnumItem
    SteppingMotor: EnumItem
    SmoothNoOutlines: EnumItem
    GetEnumItems: (self: Enum_SurfaceType) -> { EnumItem }
end

declare class Enum_SwipeDirection
    Right: EnumItem
    Left: EnumItem
    Up: EnumItem
    Down: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_SwipeDirection) -> { EnumItem }
end

declare class Enum_TableMajorAxis
    RowMajor: EnumItem
    ColumnMajor: EnumItem
    GetEnumItems: (self: Enum_TableMajorAxis) -> { EnumItem }
end

declare class Enum_Technology
    Compatibility: EnumItem
    Voxel: EnumItem
    ShadowMap: EnumItem
    Legacy: EnumItem
    Future: EnumItem
    GetEnumItems: (self: Enum_Technology) -> { EnumItem }
end

declare class Enum_TeleportMethod
    TeleportToSpawnByName: EnumItem
    TeleportToPlaceInstance: EnumItem
    TeleportToPrivateServer: EnumItem
    TeleportPartyAsync: EnumItem
    TeleportUnknown: EnumItem
    GetEnumItems: (self: Enum_TeleportMethod) -> { EnumItem }
end

declare class Enum_TeleportResult
    Success: EnumItem
    Failure: EnumItem
    GameNotFound: EnumItem
    GameEnded: EnumItem
    GameFull: EnumItem
    Unauthorized: EnumItem
    Flooded: EnumItem
    IsTeleporting: EnumItem
    GetEnumItems: (self: Enum_TeleportResult) -> { EnumItem }
end

declare class Enum_TeleportState
    RequestedFromServer: EnumItem
    Started: EnumItem
    WaitingForServer: EnumItem
    Failed: EnumItem
    InProgress: EnumItem
    GetEnumItems: (self: Enum_TeleportState) -> { EnumItem }
end

declare class Enum_TeleportType
    ToPlace: EnumItem
    ToInstance: EnumItem
    ToReservedServer: EnumItem
    GetEnumItems: (self: Enum_TeleportType) -> { EnumItem }
end

declare class Enum_TerrainAcquisitionMethod
    None: EnumItem
    Legacy: EnumItem
    Template: EnumItem
    Generate: EnumItem
    Import: EnumItem
    Convert: EnumItem
    EditAddTool: EnumItem
    EditSeaLevelTool: EnumItem
    EditReplaceTool: EnumItem
    RegionFillTool: EnumItem
    RegionPasteTool: EnumItem
    Other: EnumItem
    GetEnumItems: (self: Enum_TerrainAcquisitionMethod) -> { EnumItem }
end

declare class Enum_TerrainFace
    Top: EnumItem
    Side: EnumItem
    Bottom: EnumItem
    GetEnumItems: (self: Enum_TerrainFace) -> { EnumItem }
end

declare class Enum_TextChatMessageStatus
    Unknown: EnumItem
    Success: EnumItem
    Sending: EnumItem
    TextFilterFailed: EnumItem
    Floodchecked: EnumItem
    InvalidPrivacySettings: EnumItem
    InvalidTextChannelPermissions: EnumItem
    MessageTooLong: EnumItem
    GetEnumItems: (self: Enum_TextChatMessageStatus) -> { EnumItem }
end

declare class Enum_TextDirection
    Auto: EnumItem
    LeftToRight: EnumItem
    RightToLeft: EnumItem
    GetEnumItems: (self: Enum_TextDirection) -> { EnumItem }
end

declare class Enum_TextFilterContext
    PublicChat: EnumItem
    PrivateChat: EnumItem
    GetEnumItems: (self: Enum_TextFilterContext) -> { EnumItem }
end

declare class Enum_TextInputType
    Default: EnumItem
    NoSuggestions: EnumItem
    Number: EnumItem
    Email: EnumItem
    Phone: EnumItem
    Password: EnumItem
    PasswordShown: EnumItem
    Username: EnumItem
    OneTimePassword: EnumItem
    GetEnumItems: (self: Enum_TextInputType) -> { EnumItem }
end

declare class Enum_TextTruncate
    None: EnumItem
    AtEnd: EnumItem
    GetEnumItems: (self: Enum_TextTruncate) -> { EnumItem }
end

declare class Enum_TextXAlignment
    Left: EnumItem
    Center: EnumItem
    Right: EnumItem
    GetEnumItems: (self: Enum_TextXAlignment) -> { EnumItem }
end

declare class Enum_TextYAlignment
    Top: EnumItem
    Center: EnumItem
    Bottom: EnumItem
    GetEnumItems: (self: Enum_TextYAlignment) -> { EnumItem }
end

declare class Enum_TextureMode
    Stretch: EnumItem
    Wrap: EnumItem
    Static: EnumItem
    GetEnumItems: (self: Enum_TextureMode) -> { EnumItem }
end

declare class Enum_TextureQueryType
    NonHumanoid: EnumItem
    NonHumanoidOrphaned: EnumItem
    Humanoid: EnumItem
    HumanoidOrphaned: EnumItem
    GetEnumItems: (self: Enum_TextureQueryType) -> { EnumItem }
end

declare class Enum_ThreadPoolConfig
    Auto: EnumItem
    PerCore1: EnumItem
    PerCore2: EnumItem
    PerCore3: EnumItem
    PerCore4: EnumItem
    Threads1: EnumItem
    Threads2: EnumItem
    Threads3: EnumItem
    Threads4: EnumItem
    Threads8: EnumItem
    Threads16: EnumItem
    GetEnumItems: (self: Enum_ThreadPoolConfig) -> { EnumItem }
end

declare class Enum_ThrottlingPriority
    Extreme: EnumItem
    ElevatedOnServer: EnumItem
    Default: EnumItem
    GetEnumItems: (self: Enum_ThrottlingPriority) -> { EnumItem }
end

declare class Enum_ThumbnailSize
    Size48x48: EnumItem
    Size180x180: EnumItem
    Size420x420: EnumItem
    Size60x60: EnumItem
    Size100x100: EnumItem
    Size150x150: EnumItem
    Size352x352: EnumItem
    GetEnumItems: (self: Enum_ThumbnailSize) -> { EnumItem }
end

declare class Enum_ThumbnailType
    HeadShot: EnumItem
    AvatarBust: EnumItem
    AvatarThumbnail: EnumItem
    GetEnumItems: (self: Enum_ThumbnailType) -> { EnumItem }
end

declare class Enum_TickCountSampleMethod
    Fast: EnumItem
    Benchmark: EnumItem
    Precise: EnumItem
    GetEnumItems: (self: Enum_TickCountSampleMethod) -> { EnumItem }
end

declare class Enum_TopBottom
    Top: EnumItem
    Center: EnumItem
    Bottom: EnumItem
    GetEnumItems: (self: Enum_TopBottom) -> { EnumItem }
end

declare class Enum_TouchCameraMovementMode
    Default: EnumItem
    Follow: EnumItem
    Classic: EnumItem
    Orbital: EnumItem
    GetEnumItems: (self: Enum_TouchCameraMovementMode) -> { EnumItem }
end

declare class Enum_TouchMovementMode
    Default: EnumItem
    Thumbstick: EnumItem
    DPad: EnumItem
    Thumbpad: EnumItem
    ClickToMove: EnumItem
    DynamicThumbstick: EnumItem
    GetEnumItems: (self: Enum_TouchMovementMode) -> { EnumItem }
end

declare class Enum_TrackerError
    Ok: EnumItem
    NoService: EnumItem
    InitFailed: EnumItem
    NoVideo: EnumItem
    VideoError: EnumItem
    VideoNoPermission: EnumItem
    VideoUnsupported: EnumItem
    NoAudio: EnumItem
    AudioError: EnumItem
    AudioNoPermission: EnumItem
    UnsupportedDevice: EnumItem
    GetEnumItems: (self: Enum_TrackerError) -> { EnumItem }
end

declare class Enum_TrackerExtrapolationFlagMode
    Auto: EnumItem
    ForceDisabled: EnumItem
    ExtrapolateFacsAndPose: EnumItem
    ExtrapolateFacsOnly: EnumItem
    GetEnumItems: (self: Enum_TrackerExtrapolationFlagMode) -> { EnumItem }
end

declare class Enum_TrackerLodFlagMode
    Auto: EnumItem
    ForceFalse: EnumItem
    ForceTrue: EnumItem
    GetEnumItems: (self: Enum_TrackerLodFlagMode) -> { EnumItem }
end

declare class Enum_TrackerLodValueMode
    Auto: EnumItem
    Force0: EnumItem
    Force1: EnumItem
    GetEnumItems: (self: Enum_TrackerLodValueMode) -> { EnumItem }
end

declare class Enum_TrackerMode
    None: EnumItem
    Audio: EnumItem
    Video: EnumItem
    AudioVideo: EnumItem
    GetEnumItems: (self: Enum_TrackerMode) -> { EnumItem }
end

declare class Enum_TrackerPromptEvent
    LODCameraRecommendDisable: EnumItem
    GetEnumItems: (self: Enum_TrackerPromptEvent) -> { EnumItem }
end

declare class Enum_TriStateBoolean
    Unknown: EnumItem
    True: EnumItem
    False: EnumItem
    GetEnumItems: (self: Enum_TriStateBoolean) -> { EnumItem }
end

declare class Enum_TweenStatus
    Canceled: EnumItem
    Completed: EnumItem
    GetEnumItems: (self: Enum_TweenStatus) -> { EnumItem }
end

declare class Enum_UITheme
    Light: EnumItem
    Dark: EnumItem
    GetEnumItems: (self: Enum_UITheme) -> { EnumItem }
end

declare class Enum_UiMessageType
    UiMessageError: EnumItem
    UiMessageInfo: EnumItem
    GetEnumItems: (self: Enum_UiMessageType) -> { EnumItem }
end

declare class Enum_UsageContext
    Default: EnumItem
    Preview: EnumItem
    GetEnumItems: (self: Enum_UsageContext) -> { EnumItem }
end

declare class Enum_UserCFrame
    Head: EnumItem
    LeftHand: EnumItem
    RightHand: EnumItem
    Floor: EnumItem
    GetEnumItems: (self: Enum_UserCFrame) -> { EnumItem }
end

declare class Enum_UserInputState
    Begin: EnumItem
    Change: EnumItem
    End: EnumItem
    Cancel: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_UserInputState) -> { EnumItem }
end

declare class Enum_UserInputType
    MouseButton1: EnumItem
    MouseButton2: EnumItem
    MouseButton3: EnumItem
    MouseWheel: EnumItem
    MouseMovement: EnumItem
    Touch: EnumItem
    Keyboard: EnumItem
    Focus: EnumItem
    Accelerometer: EnumItem
    Gyro: EnumItem
    Gamepad1: EnumItem
    Gamepad2: EnumItem
    Gamepad3: EnumItem
    Gamepad4: EnumItem
    Gamepad5: EnumItem
    Gamepad6: EnumItem
    Gamepad7: EnumItem
    Gamepad8: EnumItem
    TextInput: EnumItem
    InputMethod: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_UserInputType) -> { EnumItem }
end

declare class Enum_VRSafetyBubbleMode
    NoOne: EnumItem
    OnlyFriends: EnumItem
    Anyone: EnumItem
    GetEnumItems: (self: Enum_VRSafetyBubbleMode) -> { EnumItem }
end

declare class Enum_VRScaling
    World: EnumItem
    Off: EnumItem
    GetEnumItems: (self: Enum_VRScaling) -> { EnumItem }
end

declare class Enum_VRSessionState
    Idle: EnumItem
    Visible: EnumItem
    Focused: EnumItem
    Stopping: EnumItem
    Undefined: EnumItem
    GetEnumItems: (self: Enum_VRSessionState) -> { EnumItem }
end

declare class Enum_VRTouchpad
    Left: EnumItem
    Right: EnumItem
    GetEnumItems: (self: Enum_VRTouchpad) -> { EnumItem }
end

declare class Enum_VRTouchpadMode
    Touch: EnumItem
    VirtualThumbstick: EnumItem
    ABXY: EnumItem
    GetEnumItems: (self: Enum_VRTouchpadMode) -> { EnumItem }
end

declare class Enum_VelocityConstraintMode
    Line: EnumItem
    Plane: EnumItem
    Vector: EnumItem
    GetEnumItems: (self: Enum_VelocityConstraintMode) -> { EnumItem }
end

declare class Enum_VerticalAlignment
    Center: EnumItem
    Top: EnumItem
    Bottom: EnumItem
    GetEnumItems: (self: Enum_VerticalAlignment) -> { EnumItem }
end

declare class Enum_VerticalScrollBarPosition
    Left: EnumItem
    Right: EnumItem
    GetEnumItems: (self: Enum_VerticalScrollBarPosition) -> { EnumItem }
end

declare class Enum_VibrationMotor
    Large: EnumItem
    Small: EnumItem
    LeftTrigger: EnumItem
    RightTrigger: EnumItem
    LeftHand: EnumItem
    RightHand: EnumItem
    GetEnumItems: (self: Enum_VibrationMotor) -> { EnumItem }
end

declare class Enum_ViewMode
    None: EnumItem
    GeometryComplexity: EnumItem
    Transparent: EnumItem
    Decal: EnumItem
    GetEnumItems: (self: Enum_ViewMode) -> { EnumItem }
end

declare class Enum_VirtualCursorMode
    Default: EnumItem
    Disabled: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_VirtualCursorMode) -> { EnumItem }
end

declare class Enum_VirtualInputMode
    Recording: EnumItem
    Playing: EnumItem
    None: EnumItem
    GetEnumItems: (self: Enum_VirtualInputMode) -> { EnumItem }
end

declare class Enum_VoiceChatState
    Idle: EnumItem
    Joining: EnumItem
    JoiningRetry: EnumItem
    Joined: EnumItem
    Leaving: EnumItem
    Ended: EnumItem
    Failed: EnumItem
    GetEnumItems: (self: Enum_VoiceChatState) -> { EnumItem }
end

declare class Enum_VolumetricAudio
    Disabled: EnumItem
    Automatic: EnumItem
    Enabled: EnumItem
    GetEnumItems: (self: Enum_VolumetricAudio) -> { EnumItem }
end

declare class Enum_WaterDirection
    NegX: EnumItem
    X: EnumItem
    NegY: EnumItem
    Y: EnumItem
    NegZ: EnumItem
    Z: EnumItem
    GetEnumItems: (self: Enum_WaterDirection) -> { EnumItem }
end

declare class Enum_WaterForce
    None: EnumItem
    Small: EnumItem
    Medium: EnumItem
    Strong: EnumItem
    Max: EnumItem
    GetEnumItems: (self: Enum_WaterForce) -> { EnumItem }
end

declare class Enum_WeldConstraintPreserve
    All: EnumItem
    None: EnumItem
    Touching: EnumItem
    GetEnumItems: (self: Enum_WeldConstraintPreserve) -> { EnumItem }
end

declare class Enum_WrapLayerAutoSkin
    Disabled: EnumItem
    EnabledPreserve: EnumItem
    EnabledOverride: EnumItem
    GetEnumItems: (self: Enum_WrapLayerAutoSkin) -> { EnumItem }
end

declare class Enum_WrapLayerDebugMode
    None: EnumItem
    BoundCage: EnumItem
    LayerCage: EnumItem
    BoundCageAndLinks: EnumItem
    Reference: EnumItem
    Rbf: EnumItem
    OuterCage: EnumItem
    ReferenceMeshAfterMorph: EnumItem
    HSROuterDetail: EnumItem
    HSROuter: EnumItem
    HSRInner: EnumItem
    HSRInnerReverse: EnumItem
    LayerCageFittedToBase: EnumItem
    LayerCageFittedToPrev: EnumItem
    GetEnumItems: (self: Enum_WrapLayerDebugMode) -> { EnumItem }
end

declare class Enum_WrapTargetDebugMode
    None: EnumItem
    TargetCageOriginal: EnumItem
    TargetCageCompressed: EnumItem
    TargetCageInterface: EnumItem
    TargetLayerCageOriginal: EnumItem
    TargetLayerCageCompressed: EnumItem
    TargetLayerInterface: EnumItem
    Rbf: EnumItem
    OuterCageDetail: EnumItem
    GetEnumItems: (self: Enum_WrapTargetDebugMode) -> { EnumItem }
end

declare class Enum_ZIndexBehavior
    Global: EnumItem
    Sibling: EnumItem
    GetEnumItems: (self: Enum_ZIndexBehavior) -> { EnumItem }
end

declare class GlobalEnums
    AccessModifierType: Enum_AccessModifierType
    AccessoryType: Enum_AccessoryType
    ActionType: Enum_ActionType
    ActuatorRelativeTo: Enum_ActuatorRelativeTo
    ActuatorType: Enum_ActuatorType
    AdShape: Enum_AdShape
    AdTeleportMethod: Enum_AdTeleportMethod
    AdUnitStatus: Enum_AdUnitStatus
    AdornCullingMode: Enum_AdornCullingMode
    AlignType: Enum_AlignType
    AlphaMode: Enum_AlphaMode
    AnalyticsEconomyAction: Enum_AnalyticsEconomyAction
    AnalyticsLogLevel: Enum_AnalyticsLogLevel
    AnalyticsProgressionStatus: Enum_AnalyticsProgressionStatus
    AnimationPriority: Enum_AnimationPriority
    AnimatorRetargetingMode: Enum_AnimatorRetargetingMode
    AppShellActionType: Enum_AppShellActionType
    AppShellFeature: Enum_AppShellFeature
    AppUpdateStatus: Enum_AppUpdateStatus
    ApplyStrokeMode: Enum_ApplyStrokeMode
    AspectType: Enum_AspectType
    AssetFetchStatus: Enum_AssetFetchStatus
    AssetType: Enum_AssetType
    AssetTypeVerification: Enum_AssetTypeVerification
    AudioSubType: Enum_AudioSubType
    AudioWindowSize: Enum_AudioWindowSize
    AutoIndentRule: Enum_AutoIndentRule
    AutomaticSize: Enum_AutomaticSize
    AvatarAssetType: Enum_AvatarAssetType
    AvatarChatServiceFeature: Enum_AvatarChatServiceFeature
    AvatarContextMenuOption: Enum_AvatarContextMenuOption
    AvatarItemType: Enum_AvatarItemType
    AvatarJointUpgrade: Enum_AvatarJointUpgrade
    AvatarPromptResult: Enum_AvatarPromptResult
    AvatarThumbnailCustomizationType: Enum_AvatarThumbnailCustomizationType
    AvatarUnificationMode: Enum_AvatarUnificationMode
    Axis: Enum_Axis
    BinType: Enum_BinType
    BodyPart: Enum_BodyPart
    BodyPartR15: Enum_BodyPartR15
    BorderMode: Enum_BorderMode
    BreakReason: Enum_BreakReason
    BreakpointRemoveReason: Enum_BreakpointRemoveReason
    BulkMoveMode: Enum_BulkMoveMode
    BundleType: Enum_BundleType
    Button: Enum_Button
    ButtonStyle: Enum_ButtonStyle
    CageType: Enum_CageType
    CameraMode: Enum_CameraMode
    CameraPanMode: Enum_CameraPanMode
    CameraType: Enum_CameraType
    CatalogCategoryFilter: Enum_CatalogCategoryFilter
    CatalogSortAggregation: Enum_CatalogSortAggregation
    CatalogSortType: Enum_CatalogSortType
    CellBlock: Enum_CellBlock
    CellMaterial: Enum_CellMaterial
    CellOrientation: Enum_CellOrientation
    CenterDialogType: Enum_CenterDialogType
    ChatCallbackType: Enum_ChatCallbackType
    ChatColor: Enum_ChatColor
    ChatMode: Enum_ChatMode
    ChatPrivacyMode: Enum_ChatPrivacyMode
    ChatStyle: Enum_ChatStyle
    ChatVersion: Enum_ChatVersion
    ClientAnimatorThrottlingMode: Enum_ClientAnimatorThrottlingMode
    CollisionFidelity: Enum_CollisionFidelity
    CommandPermission: Enum_CommandPermission
    CompileTarget: Enum_CompileTarget
    CompletionItemKind: Enum_CompletionItemKind
    CompletionItemTag: Enum_CompletionItemTag
    CompletionTriggerKind: Enum_CompletionTriggerKind
    ComputerCameraMovementMode: Enum_ComputerCameraMovementMode
    ComputerMovementMode: Enum_ComputerMovementMode
    ConnectionError: Enum_ConnectionError
    ConnectionState: Enum_ConnectionState
    ContextActionPriority: Enum_ContextActionPriority
    ContextActionResult: Enum_ContextActionResult
    ControlMode: Enum_ControlMode
    CoreGuiType: Enum_CoreGuiType
    CreateOutfitFailure: Enum_CreateOutfitFailure
    CreatorType: Enum_CreatorType
    CreatorTypeFilter: Enum_CreatorTypeFilter
    CurrencyType: Enum_CurrencyType
    CustomCameraMode: Enum_CustomCameraMode
    DataStoreRequestType: Enum_DataStoreRequestType
    DeathStyle: Enum_DeathStyle
    DebuggerEndReason: Enum_DebuggerEndReason
    DebuggerExceptionBreakMode: Enum_DebuggerExceptionBreakMode
    DebuggerFrameType: Enum_DebuggerFrameType
    DebuggerPauseReason: Enum_DebuggerPauseReason
    DebuggerStatus: Enum_DebuggerStatus
    DevCameraOcclusionMode: Enum_DevCameraOcclusionMode
    DevComputerCameraMovementMode: Enum_DevComputerCameraMovementMode
    DevComputerMovementMode: Enum_DevComputerMovementMode
    DevTouchCameraMovementMode: Enum_DevTouchCameraMovementMode
    DevTouchMovementMode: Enum_DevTouchMovementMode
    DeveloperMemoryTag: Enum_DeveloperMemoryTag
    DeviceType: Enum_DeviceType
    DialogBehaviorType: Enum_DialogBehaviorType
    DialogPurpose: Enum_DialogPurpose
    DialogTone: Enum_DialogTone
    DominantAxis: Enum_DominantAxis
    DraftStatusCode: Enum_DraftStatusCode
    DragDetectorDragStyle: Enum_DragDetectorDragStyle
    DragDetectorResponseStyle: Enum_DragDetectorResponseStyle
    DraggerCoordinateSpace: Enum_DraggerCoordinateSpace
    DraggerMovementMode: Enum_DraggerMovementMode
    EasingDirection: Enum_EasingDirection
    EasingStyle: Enum_EasingStyle
    ElasticBehavior: Enum_ElasticBehavior
    EnviromentalPhysicsThrottle: Enum_EnviromentalPhysicsThrottle
    ExperienceAuthScope: Enum_ExperienceAuthScope
    ExplosionType: Enum_ExplosionType
    FacialAnimationStreamingState: Enum_FacialAnimationStreamingState
    FieldOfViewMode: Enum_FieldOfViewMode
    FillDirection: Enum_FillDirection
    FilterResult: Enum_FilterResult
    FinishRecordingOperation: Enum_FinishRecordingOperation
    FluidForces: Enum_FluidForces
    Font: Enum_Font
    FontSize: Enum_FontSize
    FontStyle: Enum_FontStyle
    FontWeight: Enum_FontWeight
    ForceLimitMode: Enum_ForceLimitMode
    FormFactor: Enum_FormFactor
    FrameStyle: Enum_FrameStyle
    FramerateManagerMode: Enum_FramerateManagerMode
    FriendRequestEvent: Enum_FriendRequestEvent
    FriendStatus: Enum_FriendStatus
    FunctionalTestResult: Enum_FunctionalTestResult
    GameAvatarType: Enum_GameAvatarType
    GearGenreSetting: Enum_GearGenreSetting
    GearType: Enum_GearType
    Genre: Enum_Genre
    GraphicsMode: Enum_GraphicsMode
    GuiState: Enum_GuiState
    GuiType: Enum_GuiType
    HandlesStyle: Enum_HandlesStyle
    HighlightDepthMode: Enum_HighlightDepthMode
    HorizontalAlignment: Enum_HorizontalAlignment
    HoverAnimateSpeed: Enum_HoverAnimateSpeed
    HttpCachePolicy: Enum_HttpCachePolicy
    HttpContentType: Enum_HttpContentType
    HttpError: Enum_HttpError
    HttpRequestType: Enum_HttpRequestType
    HumanoidCollisionType: Enum_HumanoidCollisionType
    HumanoidDisplayDistanceType: Enum_HumanoidDisplayDistanceType
    HumanoidHealthDisplayType: Enum_HumanoidHealthDisplayType
    HumanoidOnlySetCollisionsOnStateChange: Enum_HumanoidOnlySetCollisionsOnStateChange
    HumanoidRigType: Enum_HumanoidRigType
    HumanoidStateMachineMode: Enum_HumanoidStateMachineMode
    HumanoidStateType: Enum_HumanoidStateType
    IKCollisionsMode: Enum_IKCollisionsMode
    IKControlConstraintSupport: Enum_IKControlConstraintSupport
    IKControlType: Enum_IKControlType
    IXPLoadingStatus: Enum_IXPLoadingStatus
    InOut: Enum_InOut
    InfoType: Enum_InfoType
    InitialDockState: Enum_InitialDockState
    InputType: Enum_InputType
    InterpolationThrottlingMode: Enum_InterpolationThrottlingMode
    JointCreationMode: Enum_JointCreationMode
    KeyCode: Enum_KeyCode
    KeyInterpolationMode: Enum_KeyInterpolationMode
    KeywordFilterType: Enum_KeywordFilterType
    Language: Enum_Language
    LeftRight: Enum_LeftRight
    Limb: Enum_Limb
    LineJoinMode: Enum_LineJoinMode
    ListDisplayMode: Enum_ListDisplayMode
    ListenerType: Enum_ListenerType
    LoadCharacterLayeredClothing: Enum_LoadCharacterLayeredClothing
    LoadDynamicHeads: Enum_LoadDynamicHeads
    MarkupKind: Enum_MarkupKind
    Material: Enum_Material
    MaterialPattern: Enum_MaterialPattern
    MembershipType: Enum_MembershipType
    MeshPartDetailLevel: Enum_MeshPartDetailLevel
    MeshPartHeadsAndAccessories: Enum_MeshPartHeadsAndAccessories
    MeshScaleUnit: Enum_MeshScaleUnit
    MeshType: Enum_MeshType
    MessageType: Enum_MessageType
    ModelLevelOfDetail: Enum_ModelLevelOfDetail
    ModelStreamingBehavior: Enum_ModelStreamingBehavior
    ModelStreamingMode: Enum_ModelStreamingMode
    ModifierKey: Enum_ModifierKey
    MouseBehavior: Enum_MouseBehavior
    MoveState: Enum_MoveState
    MuteState: Enum_MuteState
    NameOcclusion: Enum_NameOcclusion
    NetworkOwnership: Enum_NetworkOwnership
    NormalId: Enum_NormalId
    OrientationAlignmentMode: Enum_OrientationAlignmentMode
    OutfitSource: Enum_OutfitSource
    OutfitType: Enum_OutfitType
    OutputLayoutMode: Enum_OutputLayoutMode
    OverrideMouseIconBehavior: Enum_OverrideMouseIconBehavior
    PackagePermission: Enum_PackagePermission
    PartType: Enum_PartType
    ParticleEmitterShape: Enum_ParticleEmitterShape
    ParticleEmitterShapeInOut: Enum_ParticleEmitterShapeInOut
    ParticleEmitterShapeStyle: Enum_ParticleEmitterShapeStyle
    ParticleFlipbookLayout: Enum_ParticleFlipbookLayout
    ParticleFlipbookMode: Enum_ParticleFlipbookMode
    ParticleFlipbookTextureCompatible: Enum_ParticleFlipbookTextureCompatible
    ParticleOrientation: Enum_ParticleOrientation
    PathStatus: Enum_PathStatus
    PathWaypointAction: Enum_PathWaypointAction
    PermissionLevelShown: Enum_PermissionLevelShown
    PhysicsSimulationRate: Enum_PhysicsSimulationRate
    PhysicsSteppingMethod: Enum_PhysicsSteppingMethod
    Platform: Enum_Platform
    PlaybackState: Enum_PlaybackState
    PlayerActions: Enum_PlayerActions
    PlayerChatType: Enum_PlayerChatType
    PoseEasingDirection: Enum_PoseEasingDirection
    PoseEasingStyle: Enum_PoseEasingStyle
    PositionAlignmentMode: Enum_PositionAlignmentMode
    PrivilegeType: Enum_PrivilegeType
    ProductLocationRestriction: Enum_ProductLocationRestriction
    ProductPurchaseDecision: Enum_ProductPurchaseDecision
    PromptCreateAssetResult: Enum_PromptCreateAssetResult
    PromptPublishAssetResult: Enum_PromptPublishAssetResult
    PropertyStatus: Enum_PropertyStatus
    ProximityPromptExclusivity: Enum_ProximityPromptExclusivity
    ProximityPromptInputType: Enum_ProximityPromptInputType
    ProximityPromptStyle: Enum_ProximityPromptStyle
    QualityLevel: Enum_QualityLevel
    R15CollisionType: Enum_R15CollisionType
    RaycastFilterType: Enum_RaycastFilterType
    RejectCharacterDeletions: Enum_RejectCharacterDeletions
    RenderFidelity: Enum_RenderFidelity
    RenderPriority: Enum_RenderPriority
    RenderingTestComparisonMethod: Enum_RenderingTestComparisonMethod
    ReplicateInstanceDestroySetting: Enum_ReplicateInstanceDestroySetting
    ResamplerMode: Enum_ResamplerMode
    ReservedHighlightId: Enum_ReservedHighlightId
    RestPose: Enum_RestPose
    ReturnKeyType: Enum_ReturnKeyType
    ReverbType: Enum_ReverbType
    RibbonTool: Enum_RibbonTool
    RigScale: Enum_RigScale
    RigType: Enum_RigType
    RollOffMode: Enum_RollOffMode
    RotationOrder: Enum_RotationOrder
    RotationType: Enum_RotationType
    RtlTextSupport: Enum_RtlTextSupport
    RunContext: Enum_RunContext
    RuntimeUndoBehavior: Enum_RuntimeUndoBehavior
    SafeAreaCompatibility: Enum_SafeAreaCompatibility
    SalesTypeFilter: Enum_SalesTypeFilter
    SaveAvatarThumbnailCustomizationFailure: Enum_SaveAvatarThumbnailCustomizationFailure
    SaveFilter: Enum_SaveFilter
    SavedQualitySetting: Enum_SavedQualitySetting
    ScaleType: Enum_ScaleType
    ScopeCheckResult: Enum_ScopeCheckResult
    ScreenInsets: Enum_ScreenInsets
    ScreenOrientation: Enum_ScreenOrientation
    ScrollBarInset: Enum_ScrollBarInset
    ScrollingDirection: Enum_ScrollingDirection
    SelectionBehavior: Enum_SelectionBehavior
    SelectionRenderMode: Enum_SelectionRenderMode
    SelfViewPosition: Enum_SelfViewPosition
    SensorMode: Enum_SensorMode
    SensorUpdateType: Enum_SensorUpdateType
    ServerAudioBehavior: Enum_ServerAudioBehavior
    ServiceVisibility: Enum_ServiceVisibility
    Severity: Enum_Severity
    SignalBehavior: Enum_SignalBehavior
    SizeConstraint: Enum_SizeConstraint
    SolverConvergenceVisualizationMode: Enum_SolverConvergenceVisualizationMode
    SortDirection: Enum_SortDirection
    SortOrder: Enum_SortOrder
    SpecialKey: Enum_SpecialKey
    StartCorner: Enum_StartCorner
    Status: Enum_Status
    StreamOutBehavior: Enum_StreamOutBehavior
    StreamingIntegrityMode: Enum_StreamingIntegrityMode
    StreamingPauseMode: Enum_StreamingPauseMode
    StudioCloseMode: Enum_StudioCloseMode
    StudioDataModelType: Enum_StudioDataModelType
    StudioScriptEditorColorCategories: Enum_StudioScriptEditorColorCategories
    StudioScriptEditorColorPresets: Enum_StudioScriptEditorColorPresets
    StudioStyleGuideColor: Enum_StudioStyleGuideColor
    StudioStyleGuideModifier: Enum_StudioStyleGuideModifier
    Style: Enum_Style
    SurfaceConstraint: Enum_SurfaceConstraint
    SurfaceGuiShape: Enum_SurfaceGuiShape
    SurfaceGuiSizingMode: Enum_SurfaceGuiSizingMode
    SurfaceType: Enum_SurfaceType
    SwipeDirection: Enum_SwipeDirection
    TableMajorAxis: Enum_TableMajorAxis
    Technology: Enum_Technology
    TeleportMethod: Enum_TeleportMethod
    TeleportResult: Enum_TeleportResult
    TeleportState: Enum_TeleportState
    TeleportType: Enum_TeleportType
    TerrainAcquisitionMethod: Enum_TerrainAcquisitionMethod
    TerrainFace: Enum_TerrainFace
    TextChatMessageStatus: Enum_TextChatMessageStatus
    TextDirection: Enum_TextDirection
    TextFilterContext: Enum_TextFilterContext
    TextInputType: Enum_TextInputType
    TextTruncate: Enum_TextTruncate
    TextXAlignment: Enum_TextXAlignment
    TextYAlignment: Enum_TextYAlignment
    TextureMode: Enum_TextureMode
    TextureQueryType: Enum_TextureQueryType
    ThreadPoolConfig: Enum_ThreadPoolConfig
    ThrottlingPriority: Enum_ThrottlingPriority
    ThumbnailSize: Enum_ThumbnailSize
    ThumbnailType: Enum_ThumbnailType
    TickCountSampleMethod: Enum_TickCountSampleMethod
    TopBottom: Enum_TopBottom
    TouchCameraMovementMode: Enum_TouchCameraMovementMode
    TouchMovementMode: Enum_TouchMovementMode
    TrackerError: Enum_TrackerError
    TrackerExtrapolationFlagMode: Enum_TrackerExtrapolationFlagMode
    TrackerLodFlagMode: Enum_TrackerLodFlagMode
    TrackerLodValueMode: Enum_TrackerLodValueMode
    TrackerMode: Enum_TrackerMode
    TrackerPromptEvent: Enum_TrackerPromptEvent
    TriStateBoolean: Enum_TriStateBoolean
    TweenStatus: Enum_TweenStatus
    UITheme: Enum_UITheme
    UiMessageType: Enum_UiMessageType
    UsageContext: Enum_UsageContext
    UserCFrame: Enum_UserCFrame
    UserInputState: Enum_UserInputState
    UserInputType: Enum_UserInputType
    VRSafetyBubbleMode: Enum_VRSafetyBubbleMode
    VRScaling: Enum_VRScaling
    VRSessionState: Enum_VRSessionState
    VRTouchpad: Enum_VRTouchpad
    VRTouchpadMode: Enum_VRTouchpadMode
    VelocityConstraintMode: Enum_VelocityConstraintMode
    VerticalAlignment: Enum_VerticalAlignment
    VerticalScrollBarPosition: Enum_VerticalScrollBarPosition
    VibrationMotor: Enum_VibrationMotor
    ViewMode: Enum_ViewMode
    VirtualCursorMode: Enum_VirtualCursorMode
    VirtualInputMode: Enum_VirtualInputMode
    VoiceChatState: Enum_VoiceChatState
    VolumetricAudio: Enum_VolumetricAudio
    WaterDirection: Enum_WaterDirection
    WaterForce: Enum_WaterForce
    WeldConstraintPreserve: Enum_WeldConstraintPreserve
    WrapLayerAutoSkin: Enum_WrapLayerAutoSkin
    WrapLayerDebugMode: Enum_WrapLayerDebugMode
    WrapTargetDebugMode: Enum_WrapTargetDebugMode
    ZIndexBehavior: Enum_ZIndexBehavior
    GetEnums: (self: GlobalEnums) -> { GlobalEnums }
end

declare Enum: GlobalEnums

-- Top-level script globals --------------------------------------

declare game: DataModel
declare script: BaseScript
declare workspace: Workspace
declare plugin: Plugin
