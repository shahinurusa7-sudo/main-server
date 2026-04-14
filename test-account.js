/**
 * Test script to check if a user account exists in Firestore
 * 
 * Usage: node test-account.js YOUR_GOOGLE_EMAIL@gmail.com
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const auth = admin.auth();

async function checkAccount(email) {
  try {
    console.log('\n🔍 ===== ACCOUNT CHECK =====\n');
    console.log(`Checking for account with email: ${email}\n`);

    // Step 1: Check Firebase Auth
    console.log('Step 1: Checking Firebase Authentication...');
    try {
      const userRecord = await auth.getUserByEmail(email);
      console.log(`✅ Found in Firebase Auth:`);
      console.log(`   UID: ${userRecord.uid}`);
      console.log(`   Email: ${userRecord.email}`);
      console.log(`   Display Name: ${userRecord.displayName || 'Not set'}`);
      console.log(`   Email Verified: ${userRecord.emailVerified}`);
      console.log(`   Created: ${new Date(userRecord.metadata.creationTime).toLocaleString()}`);
      console.log(`   Last Sign In: ${new Date(userRecord.metadata.lastSignInTime).toLocaleString()}\n`);

      // Step 2: Check Firestore
      console.log('Step 2: Checking Firestore database...');
      console.log(`   Looking in: users/${userRecord.uid}\n`);
      
      const userDoc = await db.collection('users').doc(userRecord.uid).get();

      if (userDoc.exists) {
        console.log(`✅ Found in Firestore!`);
        const data = userDoc.data();
        console.log(`   Document data:`, JSON.stringify(data, null, 2));
        console.log('\n✅ RESULT: Account exists in both Auth and Firestore - Sign-in should work!\n');
      } else {
        console.log(`❌ NOT FOUND in Firestore!`);
        console.log(`\n⚠️  PROBLEM FOUND:`);
        console.log(`   - User exists in Firebase Auth ✅`);
        console.log(`   - User document MISSING in Firestore ❌`);
        console.log(`\n📝 TO FIX: Create a user document in Firestore:`);
        console.log(`   1. Open Firebase Console > Firestore Database`);
        console.log(`   2. Go to 'users' collection`);
        console.log(`   3. Create document with ID: ${userRecord.uid}`);
        console.log(`   4. Add required fields:`);
        console.log(`      - email: "${email}"`);
        console.log(`      - name: "Your Name"`);
        console.log(`      - gender: "male" or "female"`);
        console.log(`      - createdAt: [timestamp]`);
        console.log(`\n   OR create account via mobile app (recommended)\n`);
      }

    } catch (authError) {
      console.log(`❌ NOT FOUND in Firebase Auth`);
      console.log(`   Error: ${authError.message}`);
      console.log(`\n⚠️  PROBLEM: User does not exist in Firebase Authentication`);
      console.log(`\n📝 TO FIX: Create account via mobile app with this Google email\n`);
    }

    console.log('===========================\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error:', error);
    process.exit(1);
  }
}

// Get email from command line
const email = process.argv[2];

if (!email) {
  console.error('\n❌ Please provide an email address');
  console.error('Usage: node test-account.js YOUR_EMAIL@gmail.com\n');
  process.exit(1);
}

checkAccount(email);
