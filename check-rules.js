#!/usr/bin/env node
/* ============================================================================
   check-rules.js — structural validation for a Firestore rules file.

   Not a compiler. It catches the three failures that have actually cost time
   on this database, none of which are visible by reading:

     1. A function that is CALLED but never DEFINED.
        This is the callerEmail() bug — the ruleset is rejected outright, so
        the file silently never ships and the console keeps running an older
        version nobody can identify.

     2. A function DEFINED TWICE at the same scope.
        Also a hard deploy error. Happens when a block written standalone is
        pasted into the merged file with its own copies of signedIn(),
        userOrg() and friends.

     3. A function defined once but with DIFFERENT SEMANTICS than the caller
        expects. Cannot be detected mechanically — but the report lists every
        external helper each match block depends on, which is what makes a
        review of that possible at all.

   Usage:
     node check-rules.js firestore.rules
     node check-rules.js firestore.rules firestore-capacity-INSERT.rules
       (the second form checks the insert block against the base file as if
        it had already been pasted in)
   ========================================================================== */

var fs = require("fs");

var files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: node check-rules.js <rules-file> [insert-block ...]");
  process.exit(2);
}

var base = fs.readFileSync(files[0], "utf8");
var inserts = files.slice(1).map(function (f) {
  return { name: f, text: fs.readFileSync(f, "utf8") };
});

/* Strip comments so a function name mentioned in prose is not read as code.
   This file is heavily commented by design, and every helper name appears in
   the notes as well as the rules. */
function decomment(s) {
  return s.replace(/\/\*[\s\S]*?\*\//g, " ")   /* block comments */
          .replace(/\/\/[^\n]*/g, " ")            /* line comments  */
          .replace(/\$\(/g, " (");                /* $(database) path interpolation
                                                     is not a function call */
}

/* Splice each insert block in just before the final two closing braces, which
   is where a top-level match block lives. */
var merged = base;
if (inserts.length) {
  var cut = base.lastIndexOf("}", base.lastIndexOf("}") - 1);
  merged = base.slice(0, cut) +
           inserts.map(function (i) { return "\n" + i.text + "\n"; }).join("") +
           base.slice(cut);
}

var code = decomment(merged);
var problems = [], warnings = [];

/* ---- 1. brace balance ---------------------------------------------------- */
var depth = 0, minDepth = 0;
for (var i = 0; i < code.length; i++) {
  if (code[i] === "{") depth++;
  else if (code[i] === "}") { depth--; if (depth < minDepth) minDepth = depth; }
}
if (depth !== 0) problems.push("Braces do not balance: " + depth + " unclosed.");
if (minDepth < 0) problems.push("A closing brace appears before its opener.");

/* ---- 2. definitions, SCOPE-AWARE ------------------------------------------
   A function declared inside a match block is scoped to that block. Two
   sibling blocks may each declare mineHere(), and this file already relies on
   that — myOrgRecord() exists in both /intake_projects and /intake_requests,
   and parent() in three different subcollections.

   So duplicates are only a problem AT THE SAME SCOPE. A global name count
   flags all of the above, and a check that cries wolf gets ignored, which
   costs more than having no check at all.

   ⚠ THE MATCH-PATH REGEX HAS TO TOLERATE BRACES IN THE PATH.
   `match /databases/{database}/documents {` contains a brace pair inside the
   path itself. A lazy [^{]+ stops at that brace, so the scanner counts an
   opener it never sees closed and every depth after it is wrong — which is
   what made this report claim a block-scoped helper was at root scope. */
function scopeScan(text) {
  var t = decomment(text);
  var out = [];                      /* {name, scope, depth} */
  var stack = [], depth = 0;
  var tok = /(match\s+(\S+)\s*\{)|(\{)|(\})|(function\s+([A-Za-z_$][\w$]*)\s*\()/g, m;
  while ((m = tok.exec(t))) {
    if (m[1]) { stack.push({ path: m[2], depth: depth }); depth++; }
    else if (m[3]) { depth++; }
    else if (m[4]) {
      depth--;
      if (stack.length && stack[stack.length - 1].depth === depth) stack.pop();
    } else if (m[5]) {
      out.push({
        name: m[6],
        scope: stack.map(function (x) { return x.path; }).join(" > ") || "(root)",
        stackLen: stack.length
      });
    }
  }
  return out;
}

var allDefs = scopeScan(merged);
var defs = {}, scoped = {};
allDefs.forEach(function (d) {
  defs[d.name] = (defs[d.name] || 0) + 1;
  var key = d.scope + " :: " + d.name;
  scoped[key] = (scoped[key] || 0) + 1;
});
Object.keys(scoped).forEach(function (k) {
  if (scoped[k] > 1) {
    problems.push("Defined " + scoped[k] + " times IN THE SAME SCOPE: " + k +
      "  — duplicate definitions are a deploy error.");
  }
});

/* ---- 3. calls ------------------------------------------------------------ */
/* Everything the rules language provides, plus the method names that appear
   after a dot and are therefore never user functions. */
var BUILTIN = {
  get:1, exists:1, existsAfter:1, getAfter:1, debug:1, duration:1, hashing:1,
  latlng:1, math:1, timestamp:1, request:1, resource:1, "float":1, "int":1,
  string:1, bool:1, path:1, keys:1, values:1, size:1, hasAll:1, hasAny:1,
  hasOnly:1, diff:1, affectedKeys:1, matches:1, split:1, lower:1, upper:1,
  trim:1, replace:1, toMillis:1, date:1, year:1, month:1, day:1, time:1,
  toBase64:1, toHexString:1, toUtf8:1, is:1, "in":1, "if":1, "return":1,
  removedKeys:1, addedKeys:1, changedKeys:1, unchangedKeys:1, toSet:1,
  difference:1, intersection:1, union:1, isEqual:1
};

var callRe = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g, called = {};
while ((m = callRe.exec(code))) {
  var n = m[2];
  if (BUILTIN[n] || n === "function" || n === "match" || n === "allow") continue;
  called[n] = (called[n] || 0) + 1;
}
Object.keys(called).forEach(function (n) {
  if (!defs[n]) {
    problems.push("Called " + called[n] + "x but NEVER DEFINED: " + n + "()  — the whole ruleset will be rejected.");
  }
});

/* ---- 4. per-block dependency report -------------------------------------- */
/* Which external helpers does each match block lean on? This is the part a
   human has to review, because a helper that exists but means something
   different than you assumed deploys perfectly and quietly misbehaves. */
function blockReport(text, label) {
  var t = decomment(text);
  var local = {}, dm, lr = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
  while ((dm = lr.exec(t))) local[dm[1]] = 1;
  var ext = {}, cr = /(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g, cm;
  while ((cm = cr.exec(t))) {
    var nm = cm[2];
    if (BUILTIN[nm] || local[nm] || nm === "function" || nm === "match" || nm === "allow") continue;
    ext[nm] = 1;
  }
  console.log("\n  " + label);
  console.log("    defines locally : " + (Object.keys(local).join(", ") || "(none)"));
  console.log("    depends on      : " + (Object.keys(ext).sort().join(", ") || "(none)"));
  var clash = Object.keys(local).filter(function (n) { return baseTopLevel[n]; });
  if (clash.length) {
    problems.push(label + " redefines helper(s) that already exist in " +
      files[0] + ": " + clash.join(", ") +
      "  — either a deploy error, or a silent change of meaning across the whole file.");
  }
}

/* Root-scope helpers only — the ones shared by every collection in the file.
   A block redefining one of THESE changes its meaning database-wide.
   Redefining a name that merely exists inside some other match block is
   harmless and already common here.

   stackLen === 1 is the outer `match /databases/{db}/documents` block;
   `service {` is a plain brace and contributes no match scope. */
var baseTopLevel = {};
scopeScan(base).forEach(function (d) {
  if (d.stackLen <= 1) baseTopLevel[d.name] = 1;
});

/* ---- report -------------------------------------------------------------- */
console.log("\nFirestore rules check");
console.log("  base file        : " + files[0]);
console.log("  functions defined: " + Object.keys(defs).length);
console.log("  functions called : " + Object.keys(called).length);

if (inserts.length) {
  console.log("\n  Insert blocks:");
  inserts.forEach(function (ins) { blockReport(ins.text, ins.name); });
}

console.log("");
if (problems.length) {
  problems.forEach(function (p) { console.log("  PROBLEM  " + p); });
}
warnings.forEach(function (w) { console.log("  note     " + w); });

if (!problems.length) console.log("  No structural problems found.");
console.log("");
process.exit(problems.length ? 1 : 0);
