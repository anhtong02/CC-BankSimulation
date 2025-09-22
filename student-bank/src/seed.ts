// src/seed.ts
import admin = require("firebase-admin");
import serviceAccount = require("../firebase-key.json");

async function main() {
  console.log("Using service account project_id:", (serviceAccount as any).project_id);

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
  });
  const db = admin.firestore();

  // Write a small test doc to confirm connectivity
  const testRef = db.collection("_diagnostics").doc("seed_test");
  await testRef.set({
    wroteAt: admin.firestore.Timestamp.now(),
    note: "Hello from seed",
  });
  const testSnap = await testRef.get();
  console.log("Test write/read OK. wroteAt:", testSnap.get("wroteAt").toDate());

  // Seed 30 accounts
  const batch = db.batch();
  for (let i = 1; i <= 30; i++) {
    const cardId = `CARD_${String(i).padStart(3, "0")}`;
    const ref = db.collection("accounts").doc(cardId);
    batch.set(ref, {
      name: `Student ${i}`,
      balance: 10.0,
      createdAt: admin.firestore.Timestamp.now(),
    });
  }
  await batch.commit();
  console.log("Seeded accounts: CARD_001 … CARD_030 with $10.00");

  // Count docs to verify
  const qs = await db.collection("accounts").limit(40).get();
  console.log("accounts count (first page):", qs.size);

  console.log("✅ Done.");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ Seed failed:", e?.message || e);
  process.exit(1);
});
