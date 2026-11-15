import { generate } from "/home/user/open-haul-bench/core/gen.mjs";
let n=0,z=0,zr=0,zs=0, price=0, priceInClaim=0, ord=0;
for (let i=0;i<10;i++){ const scn=generate(20261201+i,{hours:12}); const ev=Object.fromEntries(scn.events.map(e=>[e.id,e]));
 for(const p of scn.probes.filter(p=>p.ask?.kind==="discount")){ n++; if(p.expected==="0"){ z++; const c=p.ask.c; const rv=scn.events.find(e=>e.sem.op==="rule"&&e.sem.kind==="discount"&&e.sem.c===c&&e.sem.action==="revoke"&&e.t<p.t); if(rv) zr++; else zs++; } }
 // price probes inside a price-claim window (claim .. resolution)
 const claims=scn.positives.filter(x=>x.kind==="price").map(x=>ev[x.ref]);
 for(const p of scn.probes.filter(p=>p.field==="unit_price"||p.ask?.kind==="price")){ price++; const sku=p.ask?.sku??ev[p.ref].sem.sku; if(claims.some(c=>c.sem.key===`price:${sku}`&&c.t<=p.t&&p.t<=c.t+25)){ priceInClaim++; if(p.field) ord++; } }
}
console.log({explicit_discount:n, expected_0:z, because_revoked:zr, because_below_min_qty:zs, price_probes:price, price_probes_between_claim_and_resolution:priceInClaim, of_which_orders:ord});
