/* NOMAD PAGE V49 — demandes d'accès et authentification partagées, sans plugin ChatGPT.
 * Nécessite supabase-config.js + Supabase-js dans index.html + SQL du dossier setup.
 * Ne stocke jamais les demandes dans localStorage. RLS applique les permissions sur serveur.
 */
(function(root){
 'use strict';
 const config=root.NOMAD_SUPABASE_CONFIG||{};
 const url=String(config.url||'').trim(),key=String(config.publishableKey||'').trim();
 const valid=/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url)
   && (/^sb_publishable_[a-zA-Z0-9_-]{20,}$/.test(key)||/^eyJ[a-zA-Z0-9._-]{60,}$/.test(key))
   && !/VOTRE|REMPLACER|EXEMPLE/i.test(url+' '+key);
 let client=null;
 function ready(){return valid && !!root.supabase && typeof root.supabase.createClient==='function'}
 function getClient(){
  if(!ready())throw new Error('Service non configuré : renseignez supabase-config.js, déployez le SQL, puis republiez les fichiers sur GitHub.');
  if(!client)client=root.supabase.createClient(url,key,{
   auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,storageKey:'nomad-v49-supabase-auth'}
  });
  return client;
 }
 function report(error, fallback){
   if(!error)return fallback||'Erreur inconnue';
   const msg=String(error.message||error||'Erreur inconnue');
   if(/Failed to fetch|NetworkError|Load failed/i.test(msg))return 'Connexion réseau impossible ou serveur inaccessible.';
   if(/Invalid login credentials|invalid_grant/i.test(msg))return 'Adresse e-mail ou mot de passe incorrect.';
   if(/Email not confirmed/i.test(msg))return 'Veuillez confirmer votre adresse e-mail dans le message reçu.';
   if(/duplicate key|23505/i.test(msg))return 'Cette demande est déjà enregistrée.';
   return msg;
 }
 function validateEmail(email){
   email=String(email||'').trim().toLowerCase();
   if(email.length<5||email.length>254||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new Error('Saisissez une adresse e-mail valide.');
   return email;
 }
 async function submit(email){
   email=validateEmail(email);
   const {error}=await getClient().from('nomad_access_requests').insert({email});
   if(error)throw new Error(report(error));
   return true;
 }
 async function getAuthenticatedUser(){
   const {data,error}=await getClient().auth.getUser();
   if(error||!data?.user)throw new Error('La session Supabase Auth est absente ou expirée.');
   return data.user;
 }
 async function isAdmin(){
   const u=await getAuthenticatedUser();
   const {data,error}=await getClient().from('nomad_admin_accounts').select('user_id')
      .eq('user_id',u.id).maybeSingle();
   if(error)throw new Error('Vérification des droits Gâcheur impossible : '+report(error));
   return Boolean(data?.user_id===u.id);
 }
 async function isCoterie(){
   const u=await getAuthenticatedUser();
   const {data,error}=await getClient().from('nomad_coteries').select('email,active')
      .eq('email',String(u.email||'').toLowerCase()).eq('active',true).maybeSingle();
   if(error)throw new Error('Vérification des droits Coterie impossible : '+report(error));
   return Boolean(data?.active);
 }
 async function signIn(mode,email,password){
   email=validateEmail(email);
   if(!['admin','user'].includes(mode))throw new Error('Rôle inconnu.');
   if(!password)throw new Error('Saisissez le mot de passe de votre compte Supabase Auth.');
   const c=getClient();
   const {data,error}=await c.auth.signInWithPassword({email,password});
   if(error)throw new Error(report(error));
   try{
     const permitted=mode==='admin'?await isAdmin():await isCoterie();
     if(!permitted){
       await c.auth.signOut();
       throw new Error(mode==='admin'?'Compte authentifié, mais non déclaré Gâcheur dans Supabase.':'Compte authentifié, mais votre demande n’a pas encore été approuvée dans NOMAD PAGE.');
     }
     return {role:mode,email:data?.user?.email||email};
   }catch(e){if(!/non déclaré|pas encore été approuvée/.test(e.message))await c.auth.signOut();throw e;}
 }
 async function restore(){
   if(!ready())return null;
   const c=getClient();
   const {data,error}=await c.auth.getSession();
   if(error||!data.session)return null;
   try{
     const u=await getAuthenticatedUser();
     if(await isAdmin())return {role:'admin',email:u.email};
     if(await isCoterie())return {role:'user',email:u.email};
   }catch(e){console.warn('NOMAD PAGE : session non restaurée',e.message)}
   await c.auth.signOut();
   return null;
 }
 async function list(){
   if(!await isAdmin())throw new Error('Accès aux demandes réservé au Gâcheur authentifié.');
   const {data,error}=await getClient().from('nomad_access_requests')
      .select('id,email,status,submitted_at,reviewed_at')
      .order('submitted_at',{ascending:false}).limit(300);
   if(error)throw new Error(report(error));
   return data||[];
 }
 async function review(id,status){
   if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(id||'')))throw new Error('Demande inconnue.');
   if(!['approved','rejected'].includes(status))throw new Error('Décision invalide.');
   if(!await isAdmin())throw new Error('Accès réservé au Gâcheur authentifié.');
   const {data,error}=await getClient().rpc('nomad_review_request',{p_request_id:id,p_status:status});
   if(error)throw new Error(report(error));
   return data;
 }
 async function requestDeletion(){
   const user=await getAuthenticatedUser();
   if(!await isCoterie())throw new Error('Compte Coterie non autorisé.');
   const {error}=await getClient().from('nomad_account_deletion_requests').insert({user_id:user.id,email:user.email.toLowerCase()});
   if(error && error.code!=='23505')throw new Error(report(error));
   return true;
 }
 async function listDeletions(){
   if(!await isAdmin())throw new Error('Accès réservé au Gâcheur.');
   const {data,error}=await getClient().from('nomad_account_deletion_requests').select('user_id,email,status,submitted_at').eq('status','pending').order('submitted_at',{ascending:false});
   if(error)throw new Error(report(error));
   return data||[];
 }
 async function signOut(){if(!ready())return;const {error}=await getClient().auth.signOut();if(error)throw new Error(report(error));}
 root.NomadCloud=Object.freeze({ready,submit,signIn,restore,isAdmin,isCoterie,list,review,requestDeletion,listDeletions,signOut});
})(window);
