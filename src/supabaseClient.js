import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://mcxmtnlhqubaljvnwmzc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_hyjFxoC9XfNO9LdZN-N9tw_9TdICIO3";

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);