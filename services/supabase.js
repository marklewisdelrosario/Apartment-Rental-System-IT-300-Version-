import { createClient } from "@supabase/supabase-js";

// Stores the Supabase project URL and publishable key.
const supabaseUrl = "https://neorjrlkfpdoaipycdla.supabase.co";
const supabasePublishableKey =
  "sb_publishable_siV1MPVToO4LRS1UqUZDMA_4nB3yrIj";

// Creates and exports the Supabase client for use throughout the app.
export const supabase = createClient(
  supabaseUrl,
  supabasePublishableKey,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  }
);