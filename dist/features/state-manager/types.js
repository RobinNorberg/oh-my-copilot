/**
 * State Manager Types
 *
 * Type definitions for unified state management across
 * local (.omg/state/) and global (~/.omg/state/) locations.
 */
/**
 * Location where state should be stored
 */
export var StateLocation;
(function (StateLocation) {
    /** Local project state: .omg/state/{name}.json */
    StateLocation["LOCAL"] = "local";
    /** Global user state: ~/.omg/state/{name}.json */
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
    checkLegacy: true
};
//# sourceMappingURL=types.js.map