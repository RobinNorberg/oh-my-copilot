/**
 * State Manager Types
 *
 * Type definitions for unified state management across
 * local (.omg/state/) and global (XDG-aware user OMC state with legacy ~/.omg/state fallback) locations.
 */
/**
 * Location where state should be stored
 */
export var StateLocation;
(function (StateLocation) {
    /** Local project state: .omg/state/{name}.json */
    StateLocation["LOCAL"] = "local";
    /** Global user state: XDG-aware OMC state path with legacy ~/.omg/state fallback on reads */
    StateLocation["GLOBAL"] = "global";
})(StateLocation || (StateLocation = {}));
/**
 * Type guard for StateLocation
 */
export function isStateLocation(value) {
    return value === StateLocation.LOCAL || value === StateLocation.GLOBAL;
}
/**
 * Default state configuration
 */
export const DEFAULT_STATE_CONFIG = {
    createDirs: true,
};
//# sourceMappingURL=types.js.map