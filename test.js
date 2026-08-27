/* Exercises the ledger the way the UI does. No browser needed. */
global.window = global;
require("./omega-capacity-ledger.js");
require("./omega-listings-source.js");
var L = global.OmegaLedger, S = global.OmegaListings;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  ok   " + name); }
  else { fail++; console.log("  FAIL " + name + (extra ? "  -> " + extra : "")); }
}
function eq(name, a, b) { ok(name + " (" + a + " == " + b + ")", a === b); }

console.log("\n=== 1. A fresh circuit sells its whole nameplate ===");
L.setFeeder("F1000", { nameplate: 2000, queue: 0, sub: "SUB 01" });
var st = L.feederState("F1000");
eq("sellable = nameplate", st.sellable, 2000);
eq("status open", L.circuitStatus(st).key, "open");

console.log("\n=== 2. Third-party queue is subtracted before we see anything ===");
L.setFeeder("F1001", { nameplate: 2000, queue: 1400 });
st = L.feederState("F1001");
eq("sellable after queue", st.sellable, 600);
eq("status queued", L.circuitStatus(st).key, "queued");

console.log("\n=== 3. Selling site A removes capacity from neighbour site B ===");
L.reserve({ feederId: "F1000", siteId: "SITE_A", address: "4501 W 47th St",
            kw: 1500, status: "reserved", rep: "Dana" }, function (e) {
  ok("site A hold accepted", !e, e && e.message);
});
st = L.feederState("F1000");
eq("circuit now shows 500 left", st.sellable, 500);
eq("status partial", L.circuitStatus(st).key, "partial");

var sizeB = L.sizeAt({ feederId: "F1000", siteId: "SITE_B", loadKw: 1200, hours: 2 });
eq("neighbour B capped at 500 not 1200", sizeB.kw, 500);
ok("neighbour B knows the circuit is what binds", sizeB.circuitLimited);
eq("B still sees its own load ceiling", sizeB.loadCeiling, 1200);

console.log("\n=== 4. Overselling the circuit is BLOCKED, not warned about ===");
var blocked = null;
L.reserve({ feederId: "F1000", siteId: "SITE_B", address: "4620 W 47th St",
            kw: 900, status: "reserved", rep: "Marcus" }, function (e) { blocked = e; });
ok("second rep blocked from overselling", !!blocked && blocked.code === "OVERSELL", blocked && blocked.message);
eq("error reports what is actually left", Math.round(blocked.available), 500);
eq("nothing was written", L.feederState("F1000").sellable, 500);

console.log("\n=== 5. A right-sized second claim goes through ===");
var okB = "unset";
L.reserve({ feederId: "F1000", siteId: "SITE_B", address: "4620 W 47th St",
            kw: 500, status: "reserved", rep: "Marcus" }, function (e) { okB = e; });
ok("500 kW accepted", okB === null, okB && okB.message);
eq("circuit now fully claimed", L.feederState("F1000").sellable, 0);
eq("status closed", L.circuitStatus(L.feederState("F1000")).key, "closed");

console.log("\n=== 6. Editing your OWN claim is not self-blocking ===");
var okEdit = "unset";
L.reserve({ feederId: "F1000", siteId: "SITE_A", kw: 1500, status: "application",
            rep: "Dana" }, function (e) { okEdit = e; });
ok("A upgraded to filed application", okEdit === null, okEdit && okEdit.message);
st = L.feederState("F1000");
eq("1500 moved from soft to firm", st.firm, 1500);
eq("soft is now just B", st.soft, 500);

console.log("\n=== 7. Firm claims never expire; soft ones do ===");
var A = L.allocations("F1000").filter(function (a) { return a.siteId === "SITE_A"; })[0];
var B = L.allocations("F1000").filter(function (a) { return a.siteId === "SITE_B"; })[0];
ok("filed application has no expiry", A.expiresAt === null);
ok("soft hold has an expiry", B.expiresAt > Date.now());
eq("soft hold defaults to 30 days", L.daysLeft(B), 30);

console.log("\n=== 8. A lapsed hold returns capacity automatically ===");
B.expiresAt = Date.now() - 86400000;
st = L.feederState("F1000");
eq("lapsed kW no longer consumed", st.soft, 0);
eq("lapsed kW is reported separately", st.lapsed, 500);
eq("500 kW is sellable again", st.sellable, 500);
ok("the lapsed claim is still visible for renewal", L.allocations("F1000").length === 2);

console.log("\n=== 9. Releasing returns capacity ===");
L.release(L.allocId("F1000", "SITE_A"), function () {});
eq("released kW is back", L.feederState("F1000").sellable, 2000);
eq("status back to open", L.circuitStatus(L.feederState("F1000")).key, "open");

console.log("\n=== 10. Oversubscription is surfaced, not silently clamped ===");
L.setFeeder("F1002", { nameplate: 1000, queue: 0 });
L.reserve({ feederId: "F1002", siteId: "S1", kw: 800, status: "approved", rep: "A" }, function () {});
/* force simulates a manager override / a utility restudy shrinking the circuit */
L.reserve({ feederId: "F1002", siteId: "S2", kw: 500, status: "approved", rep: "B", force: true }, function () {});
st = L.feederState("F1002");
ok("flagged oversubscribed", st.oversubscribed);
eq("over by 300", Math.round(st.overBy), 300);
eq("status over", L.circuitStatus(st).key, "over");

console.log("\n=== 11. Neighbour lookup is what powers the do-not-call warning ===");
var n = L.neighbourClaims("F1002", "S1");
eq("S1 sees one other claim", n.length, 1);
eq("and it is S2", n[0].siteId, "S2");
eq("S1 does not see itself", L.neighbourClaims("F1002", "S2")[0].siteId, "S1");

console.log("\n=== 12. Demo source is deterministic and shares circuits spatially ===");
var f1 = S.demoFeederFor(41.8500, -87.7100);
var f2 = S.demoFeederFor(41.8500, -87.7100);
eq("same point, same circuit", f1.feederId, f2.feederId);
var near = S.demoFeederFor(41.8503, -87.7104);
eq("neighbouring parcel shares the circuit", near.feederId, f1.feederId);
var far = S.demoFeederFor(41.9200, -87.6100);
ok("distant parcel is on a different circuit", far.feederId !== f1.feederId);
var c1 = S.demoCapacityFor(f1.feederId), c2 = S.demoCapacityFor(f1.feederId);
eq("capacity is stable across calls", c1.nameplate, c2.nameplate);

console.log("\n=== 13. Provider search returns stable, in-bounds rows ===");
S.use("demo");
var bbox = { s: 41.84, n: 41.87, w: -87.73, e: -87.69 };
var r1 = null, r2 = null;
S.search(bbox, {}, function (e, r) { r1 = r; });
S.search(bbox, {}, function (e, r) { r2 = r; });
ok("returned properties", r1 && r1.length > 20, r1 && r1.length);
eq("identical across runs", JSON.stringify(r1.map(function (x) { return x.id; })),
                            JSON.stringify(r2.map(function (x) { return x.id; })));
var inB = r1.every(function (x) {
  return x.lat >= bbox.s && x.lat <= bbox.n && x.lon >= bbox.w && x.lon <= bbox.e;
});
ok("all inside the viewport", inB);
var shared = {};
r1.forEach(function (x) { shared[x.feederId] = (shared[x.feederId] || 0) + 1; });
var multi = Object.keys(shared).filter(function (k) { return shared[k] > 1; });
ok("circuits are genuinely shared between properties", multi.length > 5, multi.length + " shared circuits");
ok("every row carries a source stamp", r1.every(function (x) { return x.src === "demo"; }));
ok("modelled energy is labelled modelled",
   r1.filter(function (x) { return x.annualKwh; }).every(function (x) { return x.annualKwh.src === "modelled"; }));

console.log("\n=== 14. CSV export round-trips ===");
var csv = L.csv();
ok("has a header", csv.split("\n")[0].indexOf("circuit,substation") === 0);
ok("has rows", csv.split("\n").length > 3);

console.log("\n" + (fail ? "FAILED " + fail : "ALL PASS") + "  (" + pass + " assertions)\n");
process.exit(fail ? 1 : 0);
