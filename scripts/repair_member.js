// Script to repair missing membership for a user
// Copy-paste this into your browser console while logged into the app as an Admin (or while on the signup page)

// 1. Replace these values with the specific IDs involved
const TARGET_ORG_ID = "YOUR_ORG_ID_HERE"; // The ID of the organization
const TARGET_USER_ID = "YOUR_MISSING_USER_UID"; // The UID of the user who is missing
const TARGET_EMAIL = "user@example.com"; 

// 2. Paste this entire block into the console
async function repairMember() {
  const { doc, setDoc, serverTimestamp } = await import("firebase/firestore");
  const { db } = await import("@/lib/firebase"); // Adjust import path if needed based on where you run this

  console.log("Attempting to repair membership...");

  try {
    const memberRef = doc(db, "orgs", TARGET_ORG_ID, "members", TARGET_USER_ID);
    
    await setDoc(memberRef, {
      uid: TARGET_USER_ID,
      orgId: TARGET_ORG_ID,
      email: TARGET_EMAIL,
      role: "Viewer", // Or "Admin", "Drafter", etc.
      status: "active", // CRITICAL: This was likely missing
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }, { merge: true });

    console.log("✅ SUCCESS: Member document created/repaired!");
    console.log(`Path: orgs/${TARGET_ORG_ID}/members/${TARGET_USER_ID}`);
  } catch (e) {
    console.error("❌ FAILED:", e);
  }
}

// 3. Run it
// repairMember();
