// src/server.ts
import express = require("express");
import admin = require("firebase-admin");
import serviceAccount = require("../firebase-key.json");
import path = require("path");

// Init Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount as admin.ServiceAccount),
});
const db = admin.firestore();

// Minimal Express app
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// simple anti double-tap memory
const lastTapAt = new Map<string, number>();

// /tap — credit charge with frozen check + dedupe + limit
app.post("/tap", async (req, res) => {
  try {
    let { accountId, cardUid, amount, memo, merchant } = req.body as {
      accountId?: string; cardUid?: string; amount?: number; memo?: string; merchant?: string;
    };
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "positive amount required" });
    }

    // Resolve accountId from card UID if needed
    if (!accountId && cardUid) {
      const map = await db.collection("cards").doc(cardUid).get();
      if (!map.exists) return res.status(404).json({ error: "card not linked" });
      accountId = (map.data() as any).accountId as string;
    }
    if (!accountId) return res.status(400).json({ error: "accountId or cardUid required" });

    // de-dupe
    const now = Date.now();
    const prev = lastTapAt.get(accountId) || 0;
    if (now - prev < 2000) return res.status(429).json({ error: "duplicate tap" });
    lastTapAt.set(accountId, now);

    const acctRef = db.collection("accounts").doc(accountId);

    const newCreditBal = await db.runTransaction(async (t) => {
      const snap = await t.get(acctRef);
      if (!snap.exists) throw new Error("Account not found");
      const a = snap.data() as any;

      if (a.frozen) throw new Error("Card is frozen");

      const credit = a.credit || {};
      const limit = Number(credit.limit ?? 500);
      const bal   = Number(credit.balance ?? 0);
      const next  = Number((bal + amount).toFixed(2));
      if (next > limit) throw new Error("Over credit limit");

      // ✅ ONLY update credit.balance (do NOT touch checking)
      t.update(acctRef, { credit: { ...credit, balance: next }, updatedAt: admin.firestore.Timestamp.now() });

      // txn log
      t.set(db.collection("transactions").doc(), {
        accountId,
        type: "credit_charge",
        amount,
        memo: memo || "Tap purchase",
        counterparty: merchant || "Class Register",
        newCreditBalance: next,
        time: admin.firestore.Timestamp.now(),
      });

      return next;
    });

    res.json({ status: "ok", accountId, creditBalance: newCreditBal });
  } catch (e:any) {
    res.status(400).json({ error: e?.message ?? "tap failed" });
  }
});






// /pay-credit — move money from Checking -> Credit balance
app.post("/pay-credit", async (req, res) => {
  try {
    let { accountId, cardUid, amount } = req.body as { accountId?: string; cardUid?: string; amount?: number };
    if (typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "positive amount required" });
    }

    if (!accountId && cardUid) {
      const map = await db.collection("cards").doc(cardUid).get();
      if (!map.exists) return res.status(404).json({ error: "card not linked" });
      accountId = (map.data() as any).accountId as string;
    }
    if (!accountId) return res.status(400).json({ error: "accountId or cardUid required" });

    const ref = db.collection("accounts").doc(accountId);
    const { newChecking, newCredit } = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new Error("Account not found");
      const a = snap.data() as any;

      const checking = Number(a.checking || 0);
      const credit = a.credit || {};
      const bal = Number(credit.balance || 0);

      if (checking < amount) throw new Error("Insufficient checking funds");

      const paid = Math.min(amount, bal);
      const nextChk = Number((checking - paid).toFixed(2));
      const nextCred = Number((bal - paid).toFixed(2));

      t.update(ref, { checking: nextChk, credit: { ...credit, balance: nextCred }, updatedAt: admin.firestore.Timestamp.now() });
      t.set(db.collection("transactions").doc(), {
        accountId,
        type: "credit_payment",
        amount: paid,
        newChecking: nextChk,
        newCreditBalance: nextCred,
        time: admin.firestore.Timestamp.now(),
      });

      return { newChecking: nextChk, newCredit: nextCred };
    });

    res.json({ status: "ok", accountId, checking: newChecking, creditBalance: newCredit });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "pay-credit failed" });
  }
});











// /credit — add funds
app.post("/credit", async (req, res) => {
  try {
    const { cardId, amount } = req.body as { cardId?: string; amount?: number };
    if (!cardId || typeof amount !== "number" || amount <= 0) {
      return res.status(400).json({ error: "cardId and positive amount required" });
    }
    const acctRef = db.collection("accounts").doc(cardId);
    const newBalance = await db.runTransaction(async (t) => {
      const snap = await t.get(acctRef);
      if (!snap.exists) throw new Error("Account not found");
      const acct = snap.data() as { balance: number };
      const next = Number((acct.balance + amount).toFixed(2));
      t.update(acctRef, { balance: next, updatedAt: admin.firestore.Timestamp.now() });
      t.set(db.collection("transactions").doc(), {
        cardId,
        amount,
        newBalance: next,
        type: "credit",
        time: admin.firestore.Timestamp.now(),
      });
      return next;
    });
    res.json({ status: "ok", balance: newBalance });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "credit failed" });
  }
});

// /freeze — set frozen flag
app.post("/freeze", async (req, res) => {
  try {
    const { cardId, frozen } = req.body as { cardId?: string; frozen?: boolean };
    if (!cardId || typeof frozen !== "boolean") {
      return res.status(400).json({ error: "cardId and frozen=true|false required" });
    }
    const ref = db.collection("accounts").doc(cardId);
    await ref.update({ frozen, updatedAt: admin.firestore.Timestamp.now() });
    res.json({ status: "ok", cardId, frozen });
  } catch (e: any) {
    res.status(400).json({ error: e?.message ?? "freeze failed" });
  }
});

// Debug helpers
app.get("/account/:cardId", async (req, res) => {
  const doc = await db.collection("accounts").doc(req.params.cardId).get();
  if (!doc.exists) return res.status(404).json({ error: "not found" });
  res.json({ id: doc.id, ...doc.data() });
});

app.get("/transactions/:cardId", async (req, res) => {
  const qs = await db.collection("transactions")
    .where("cardId", "==", req.params.cardId)
    .orderBy("time", "desc")
    .limit(20)
    .get();
  res.json({ items: qs.docs.map(d => ({ id: d.id, ...d.data() })) });
});

// Create an account by chosen ID (no card yet)
app.post("/register", async (req, res) => {
  try {
    const body = req.body || {};
    const accountId = (body.accountId ?? body.id ?? "").trim();
    const name = (body.name ?? "").trim();
    const stipend = Number(body.stipend ?? 10); // default $10 per run
    if (!accountId || !name) return res.status(400).json({ error: "accountId (or id) and name required" });

    const ref = db.collection("accounts").doc(accountId);
    const snap = await ref.get();
    if (snap.exists) return res.status(400).json({ error: "ID already taken" });

    await ref.set({
      name,
      checking: 0, savings: 0, hysa: 0,
      hysaAPR: 0.045, frozen: false,
      stipend, payEnabled: true,           // 👈 new
      credit: { limit: 500, balance: 0, apr: 0.18, lastStatementDay: 0, dueDay: 0, dueAmount: 0 },
      creditScore: 600,
      createdAt: admin.firestore.Timestamp.now(),
      updatedAt: admin.firestore.Timestamp.now(),
    });
    res.json({ status: "ok", accountId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});




// Link card -> account (tap once to capture uid on a small UI, then call this)
app.post("/link-card", async (req, res) => {
  try {
    const { cardUid, accountId } = req.body as { cardUid: string; accountId: string };
    if (!cardUid || !accountId) return res.status(400).json({ error: "cardUid and accountId required" });

    // ensure account exists
    const acct = await db.collection("accounts").doc(accountId).get();
    if (!acct.exists) return res.status(404).json({ error: "account not found" });

    // record mapping
    await db.collection("cards").doc(cardUid).set({
      accountId, linkedAt: admin.firestore.Timestamp.now()
    });
    res.json({ status: "ok", cardUid, accountId });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

app.post("/unlink-card", async (req, res) => {
  try {
    const { cardUid } = req.body as { cardUid: string };
    if (!cardUid) return res.status(400).json({ error: "cardUid required" });
    await db.collection("cards").doc(cardUid).delete();
    res.json({ status: "ok", cardUid });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /admin/payroll/simple { multiplier?: number }
app.post("/admin/payroll/simple", async (req, res) => {
  try {
    const { multiplier = 1 } = req.body || {};
    const qs = await db.collection("accounts").where("payEnabled", "==", true).get();
    const batch = db.batch();
    let paid = 0, total = 0;

    for (const doc of qs.docs) {
      const a = doc.data() as any;
      const amt = Number(((a.stipend ?? 0) * multiplier).toFixed(2));
      if (amt <= 0) continue;

      batch.update(doc.ref, {
        checking: admin.firestore.FieldValue.increment(amt),
        updatedAt: admin.firestore.Timestamp.now()
      });
      batch.set(db.collection("transactions").doc(), {
        accountId: doc.id, type: "credit", amount: amt, memo: "Paycheck", time: admin.firestore.Timestamp.now()
      });
      paid++; total += amt;
    }
    await batch.commit();
    res.json({ status: "ok", paid, total: Number(total.toFixed(2)) });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});

// POST /admin/payroll/pay-one { accountId: string, amount?: number }
app.post("/admin/payroll/pay-one", async (req, res) => {
  try {
    const { accountId, amount } = req.body || {};
    if (!accountId) return res.status(400).json({ error: "accountId required" });

    const ref = db.collection("accounts").doc(accountId);
    await db.runTransaction(async t => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new Error("Account not found");
      const a = snap.data() as any;
      const amt = Number((amount ?? a.stipend ?? 0).toFixed(2));
      if (amt <= 0) throw new Error("No stipend or amount is zero");

      const next = Number(((a.checking || 0) + amt).toFixed(2));
      t.update(ref, { checking: next, updatedAt: admin.firestore.Timestamp.now() });
      t.set(db.collection("transactions").doc(), {
        accountId, type: "credit", amount: amt, memo: "Paycheck", time: admin.firestore.Timestamp.now()
      });
    });
    res.json({ status: "ok" });
  } catch (e: any) { res.status(400).json({ error: e.message }); }
});



// Toggle payEnabled for a single student
// POST /admin/payroll/toggle { accountId: string, enabled: boolean }
app.post("/admin/payroll/toggle", async (req, res) => {
  try {
    const { accountId, enabled } = req.body || {};
    if (!accountId || typeof enabled !== "boolean") {
      return res.status(400).json({ error: "accountId and enabled=true|false required" });
    }
    const ref = db.collection("accounts").doc(accountId);
    await ref.update({
      payEnabled: enabled,
      updatedAt: admin.firestore.Timestamp.now()
    });
    res.json({ status: "ok", accountId, enabled });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

// Update stipend (paycheck amount) for a single student
// POST /admin/payroll/set-stipend { accountId: string, stipend: number }
app.post("/admin/payroll/set-stipend", async (req, res) => {
  try {
    const { accountId, stipend } = req.body || {};
    const val = Number(stipend);
    if (!accountId || !Number.isFinite(val) || val < 0) {
      return res.status(400).json({ error: "accountId and non-negative stipend required" });
    }
    const ref = db.collection("accounts").doc(accountId);
    await ref.update({
      stipend: val,
      updatedAt: admin.firestore.Timestamp.now()
    });
    res.json({ status: "ok", accountId, stipend: val });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});
// MOVE money between a student's own buckets (checking/savings/hysa)
app.post("/transfer", async (req, res) => {
  try {
    let { accountId, cardUid, from, to, amount } = req.body as {
      accountId?: string; cardUid?: string;
      from?: "checking" | "savings" | "hysa";
      to?: "checking" | "savings" | "hysa";
      amount?: number;
    };

    // Resolve accountId from card if needed
    if (!accountId && cardUid) {
      const map = await db.collection("cards").doc(cardUid).get();
      if (!map.exists) return res.status(404).json({ error: "card not linked" });
      accountId = (map.data() as any).accountId;
    }

    if (!accountId || !from || !to || typeof amount !== "number")
      return res.status(400).json({ error: "accountId/cardUid, from, to, amount required" });

    if (from === to) return res.status(400).json({ error: "from and to must differ" });
    if (!["checking", "savings", "hysa"].includes(from) || !["checking", "savings", "hysa"].includes(to))
      return res.status(400).json({ error: "from/to must be checking|savings|hysa" });
    if (amount <= 0) return res.status(400).json({ error: "amount must be > 0" });

    const ref = db.collection("accounts").doc(accountId);

    const result = await db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new Error("Account not found");
      const a = snap.data() as any;

      const fromBal = Number(a[from] || 0);
      const toBal   = Number(a[to]   || 0);

      if (fromBal < amount) throw new Error("Insufficient funds");

      const nextFrom = Number((fromBal - amount).toFixed(2));
      const nextTo   = Number((toBal + amount).toFixed(2));

      t.update(ref, {
        [from]: nextFrom,
        [to]: nextTo,
        updatedAt: admin.firestore.Timestamp.now(),
      });

      t.set(db.collection("transactions").doc(), {
        accountId,
        type: "transfer",
        from, to,
        amount: Number(amount.toFixed(2)),
        time: admin.firestore.Timestamp.now(),
      });

      return { [from]: nextFrom, [to]: nextTo };
    });

    res.json({ status: "ok", accountId, ...result });
  } catch (e:any) {
    res.status(400).json({ error: e.message || "transfer failed" });
  }
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
