// Empty module: webpack's NormalModuleReplacementPlugin points node:*
// requires (and a few bare names like `fs`, `path`) at this file in the
// browser bundle. The Luau WASM glue only reads these on Node; in the
// browser branch nothing touches the exports.
module.exports = {};
