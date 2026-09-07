// Fill these in after you create your Supabase project (see SETUP.md).
//
// The anon key below is SAFE to be public / committed to the repo: it can
// only call the three narrow functions defined in supabase_schema.sql
// (signup_subscriber, verify_subscriber, unsubscribe_subscriber) — it has no
// direct read or write access to the subscribers table itself.
window.NCT_CONFIG = {
  SUPABASE_URL: "https://msielptaibzpqfqlhrig.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zaWVscHRhaWJ6cHFmcWxocmlnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODg4MTA4NjQsImV4cCI6MjEwNDM4Njg2NH0.bVIRryRk_ljfPs1kd9DrHLV2_TggqE2-O7kPrgjh5Ek",

  // Optional — leave both blank until your AdSense account is approved.
  // Ads only load when ADSENSE_CLIENT_ID is filled in (see SETUP.md "Set up ads").
  ADSENSE_CLIENT_ID: "",   // e.g. "ca-pub-1234567890123456"
  ADSENSE_SLOT_ID: "",     // e.g. "1234567890"
};
