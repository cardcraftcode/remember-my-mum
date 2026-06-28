import { createClient } from '@supabase/supabase-js'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { storage: undefined, persistSession: false, autoRefreshToken: false }
})

const { data, error } = await supabase.from('shopify_auth_states').select('id').limit(1)
if (error) {
  console.error('Table check error:', error.message)
  process.exit(1)
}
console.log('Table exists, rows:', data.length)
