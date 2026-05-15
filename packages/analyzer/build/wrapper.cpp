// Single-source Luau type-checker wrapper for WebAssembly.
//
// Exposes one C entry point, luau_analyze(source, len), which runs
// Luau.Analysis's Frontend against an in-memory single-file project
// and returns a JSON string describing every TypeError the frontend
// emitted. Used by @luau2ts/analyzer to surface Luau-side semantic
// errors before the luau2ts compiler runs codegen.

#include "Luau/Frontend.h"
#include "Luau/BuiltinDefinitions.h"
#include "Luau/Config.h"
#include "Luau/ConfigResolver.h"
#include "Luau/Error.h"
#include "Luau/FileResolver.h"
#include "Luau/Location.h"
#include "Luau/Module.h"
#include "Luau/Scope.h"
#include "Luau/Type.h"
#include "Luau/TypeArena.h"

// Generated header: const char kRobloxGlobals[] / size_t kRobloxGlobalsLen
// holding the Roblox-globals Luau definition source produced by
// scripts/gen-roblox-defs.mjs and embedded via build/embed-globals.mjs.
#include "roblox_globals_data.h"

#include <emscripten.h>
#include <string_view>

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <optional>
#include <sstream>
#include <string>

namespace {

class SingleFileResolver final : public Luau::FileResolver {
 public:
  explicit SingleFileResolver(std::string src) : source_(std::move(src)) {}

  std::optional<Luau::SourceCode> readSource(const Luau::ModuleName& name) override {
    if (name != kModule) return std::nullopt;
    return Luau::SourceCode{source_, Luau::SourceCode::Module};
  }

  static constexpr const char* kModule = "input";

 private:
  std::string source_;
};

class NullConfigResolver final : public Luau::ConfigResolver {
 public:
  const Luau::Config& getConfig(const Luau::ModuleName&, const Luau::TypeCheckLimits&) const override {
    return defaultConfig_;
  }

 private:
  Luau::Config defaultConfig_;
};

void jsonEscape(std::string& out, const std::string& s) {
  out.push_back('"');
  for (char ch : s) {
    auto c = static_cast<unsigned char>(ch);
    switch (c) {
      case '"': out.append("\\\""); break;
      case '\\': out.append("\\\\"); break;
      case '\b': out.append("\\b"); break;
      case '\f': out.append("\\f"); break;
      case '\n': out.append("\\n"); break;
      case '\r': out.append("\\r"); break;
      case '\t': out.append("\\t"); break;
      default:
        if (c < 0x20) {
          char buf[8];
          std::snprintf(buf, sizeof(buf), "\\u%04x", c);
          out.append(buf);
        } else {
          out.push_back(static_cast<char>(c));
        }
    }
  }
  out.push_back('"');
}

// Discriminator label for each TypeError variant. Luau uses its own
// Variant type (not std::variant) so we dispatch through Luau::visit.
const char* codeNameOf(const Luau::TypeError& err) {
  return Luau::visit([](auto&& v) -> const char* {
    using T = std::decay_t<decltype(v)>;
    if constexpr (std::is_same_v<T, Luau::TypeMismatch>) return "TypeMismatch";
    else if constexpr (std::is_same_v<T, Luau::UnknownSymbol>) return "UnknownSymbol";
    else if constexpr (std::is_same_v<T, Luau::UnknownProperty>) return "UnknownProperty";
    else if constexpr (std::is_same_v<T, Luau::NotATable>) return "NotATable";
    else if constexpr (std::is_same_v<T, Luau::CannotExtendTable>) return "CannotExtendTable";
    else if constexpr (std::is_same_v<T, Luau::OnlyTablesCanHaveMethods>) return "OnlyTablesCanHaveMethods";
    else if constexpr (std::is_same_v<T, Luau::DuplicateTypeDefinition>) return "DuplicateTypeDefinition";
    else if constexpr (std::is_same_v<T, Luau::CountMismatch>) return "CountMismatch";
    else if constexpr (std::is_same_v<T, Luau::FunctionDoesNotTakeSelf>) return "FunctionDoesNotTakeSelf";
    else if constexpr (std::is_same_v<T, Luau::FunctionRequiresSelf>) return "FunctionRequiresSelf";
    else if constexpr (std::is_same_v<T, Luau::OccursCheckFailed>) return "OccursCheckFailed";
    else if constexpr (std::is_same_v<T, Luau::UnknownRequire>) return "UnknownRequire";
    else if constexpr (std::is_same_v<T, Luau::IncorrectGenericParameterCount>) return "IncorrectGenericParameterCount";
    else if constexpr (std::is_same_v<T, Luau::SyntaxError>) return "SyntaxError";
    else if constexpr (std::is_same_v<T, Luau::CodeTooComplex>) return "CodeTooComplex";
    else if constexpr (std::is_same_v<T, Luau::UnificationTooComplex>) return "UnificationTooComplex";
    else if constexpr (std::is_same_v<T, Luau::UnknownPropButFoundLikeProp>) return "UnknownPropButFoundLikeProp";
    else if constexpr (std::is_same_v<T, Luau::GenericError>) return "GenericError";
    else if constexpr (std::is_same_v<T, Luau::CannotCallNonFunction>) return "CannotCallNonFunction";
    else if constexpr (std::is_same_v<T, Luau::ExtraInformation>) return "ExtraInformation";
    else if constexpr (std::is_same_v<T, Luau::DeprecatedApiUsed>) return "DeprecatedApiUsed";
    else if constexpr (std::is_same_v<T, Luau::ModuleHasCyclicDependency>) return "ModuleHasCyclicDependency";
    else if constexpr (std::is_same_v<T, Luau::IllegalRequire>) return "IllegalRequire";
    else if constexpr (std::is_same_v<T, Luau::FunctionExitsWithoutReturning>) return "FunctionExitsWithoutReturning";
    else return "Error";
  }, err.data);
}

thread_local std::string g_lastResult;

}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE
const char* luau_analyze(const char* source, std::size_t len) {
  std::string src(source, len);
  SingleFileResolver fileResolver(src);
  NullConfigResolver configResolver;

  Luau::FrontendOptions options;
  options.retainFullTypeGraphs = false;
  options.runLintChecks = true;

  Luau::Frontend frontend(&fileResolver, &configResolver, options);
  Luau::registerBuiltinGlobals(frontend, frontend.globals);

  // Roblox runtime globals (task, datatypes, classes, services, ...) that
  // ship with the Roblox VM but aren't part of Luau's core stdlib. Without
  // these declarations the analyzer flags every Roblox API as UnknownSymbol.
  //
  // The definitions are generated from Roblox's API-Dump.json by
  // scripts/gen-roblox-defs.mjs, embedded into a C++ header at build time
  // (build/build.sh runs embed-globals.mjs before emcc), and linked in here.
  // Loaded after registerBuiltinGlobals (which loads Luau's own builtins)
  // and before freeze.
  Luau::LoadDefinitionFileResult defsResult = frontend.loadDefinitionFile(
      frontend.globals, frontend.globals.globalScope,
      std::string_view(reinterpret_cast<const char*>(kRobloxGlobals), kRobloxGlobalsLen),
      "@roblox", /*captureComments*/ false);
  if (!defsResult.success) {
    // Surface the parse errors as JSON-tagged diagnostics so the user sees
    // exactly which line in roblox-globals.d.lua broke the load. Without
    // this we silently lose every Roblox global and every script flags
    // "Unknown global 'game'" etc., which is impossible to debug.
    std::ostringstream out;
    out << "{\"errors\":[";
    bool first = true;
    for (const auto& err : defsResult.parseResult.errors) {
      if (!first) out << ',';
      first = false;
      std::string esc;
      jsonEscape(esc, std::string("[roblox-globals.d.lua] ") + err.getMessage());
      out << "{";
      out << "\"line\":" << (err.getLocation().begin.line + 1);
      out << ",\"col\":" << (err.getLocation().begin.column + 1);
      out << ",\"endLine\":" << (err.getLocation().end.line + 1);
      out << ",\"endCol\":" << (err.getLocation().end.column + 1);
      out << ",\"code\":\"DefinitionFileParseError\"";
      out << ",\"message\":" << esc;
      out << "}";
    }
    out << "],\"warnings\":[]}";
    g_lastResult = out.str();
    return g_lastResult.c_str();
  }

  // Pin every loaded global binding so its TypeId isn't reclaimed by
  // type-arena cleanup mid-check. registerBuiltinGlobals does this for
  // its own bindings via a file-local finalizeGlobalBindings(); we have
  // to mirror that for the additional Roblox globals we just loaded, or
  // subsequent frontend.check() runs silently lose them and the analyzer
  // reports zero diagnostics for everything (including syntax errors).
  for (const auto& [_, binding] : frontend.globals.globalScope->bindings) {
    Luau::persist(binding.typeId);
  }

  Luau::freeze(frontend.globals.globalTypes);

  Luau::CheckResult result;
  try {
    result = frontend.check(SingleFileResolver::kModule);
  } catch (const std::exception& e) {
    std::string msg = std::string("frontend.check threw: ") + e.what();
    std::string out = "{\"errors\":[{\"line\":0,\"col\":0,\"endLine\":0,\"endCol\":0,\"code\":\"FrontendException\",\"message\":";
    std::string esc;
    jsonEscape(esc, msg);
    out.append(esc);
    out.append("}],\"warnings\":[]}");
    g_lastResult = std::move(out);
    return g_lastResult.c_str();
  }

  std::ostringstream out;
  out << "{\"errors\":[";
  bool first = true;
  for (const Luau::TypeError& err : result.errors) {
    if (!first) out << ',';
    first = false;
    out << "{";
    out << "\"line\":" << (err.location.begin.line + 1);
    out << ",\"col\":" << (err.location.begin.column + 1);
    out << ",\"endLine\":" << (err.location.end.line + 1);
    out << ",\"endCol\":" << (err.location.end.column + 1);
    out << ",\"code\":\"" << codeNameOf(err) << "\"";
    std::string msg = Luau::toString(err);
    std::string esc;
    jsonEscape(esc, msg);
    out << ",\"message\":" << esc;
    out << "}";
  }
  out << "],\"warnings\":[";
  first = true;
  for (const Luau::LintWarning& w : result.lintResult.warnings) {
    if (!first) out << ',';
    first = false;
    out << "{";
    out << "\"line\":" << (w.location.begin.line + 1);
    out << ",\"col\":" << (w.location.begin.column + 1);
    out << ",\"endLine\":" << (w.location.end.line + 1);
    out << ",\"endCol\":" << (w.location.end.column + 1);
    out << ",\"code\":\"" << Luau::LintWarning::getName(w.code) << "\"";
    std::string esc;
    jsonEscape(esc, w.text);
    out << ",\"message\":" << esc;
    out << "}";
  }
  out << "]}";

  g_lastResult = out.str();
  return g_lastResult.c_str();
}

EMSCRIPTEN_KEEPALIVE
void luau_analyzer_free(char* /*ptr*/) {
  // The result string is owned by g_lastResult (thread-local). Caller
  // doesn't need to free it; the next call overwrites the buffer.
}

}  // extern "C"
