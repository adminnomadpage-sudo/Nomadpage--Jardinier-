/* NOMAD PAGE V53 — demandes d'accès et authentification partagées, sans plugin ChatGPT.
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
   if(/Invalid login credentials|invalid_grant/i.test(msg))return 'Identifiants Gâcheur incorrects.';
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
   if(mode!=='admin')throw new Error('Connexion administrateur uniquement : les Coteries utilisent la vérification d’adresse en consultation limitée.');
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
  /* V51 : une simple adresse e-mail ne prouve PAS l'identité.
   * On vérifie seulement l'éligibilité à un aperçu NON CONFIDENTIEL.
   * Ne jamais utiliser ce résultat pour lire des données privées ni modifier quoi que ce soit.
   */
  async function checkPublicEligibility(email){
    email=validateEmail(email);
    const {data,error}=await getClient().rpc('nomad_v51_public_eligibility',{p_email:email});
    if(error){
      if(/PGRST202|404|42883|function.*does not exist/i.test(String(error.message||'')))
        throw new Error('La vérification V51 doit d’abord être installée dans Supabase : exécutez INSTALLER_V51_VERIFICATION_EMAIL.sql dans SQL Editor.');
      throw new Error('Vérification indisponible : '+report(error));
    }
    return data === true;
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
 /* V52 — Gestion distante des accès ; les deux RPC vérifient auth.uid() côté serveur. */
 async function listCoteries(){
   if(!await isAdmin())throw new Error('Seul le Gâcheur peut consulter les accès.');
   const {data,error}=await getClient().rpc('nomad_v52_list_coteries');
   if(error)throw new Error('Liste indisponible : '+report(error)+'. Avez-vous exécuté INSTALLER_V52_GESTION_ACCES.sql ?');
   return Array.isArray(data)?data:[];
 }
 async function setCoterieAccess(email,active){
   email=validateEmail(email);
   if(typeof active!=='boolean')throw new Error('Statut invalide.');
   if(!await isAdmin())throw new Error('Seul le Gâcheur peut modifier les accès.');
   const {data,error}=await getClient().rpc('nomad_v52_set_coterie_access',{p_email:email,p_active:active});
   if(error)throw new Error(report(error));
   if(!data || data.email!==email || data.active!==active)throw new Error('Réponse Supabase inattendue, état non confirmé.');
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

 // V53 — shared resources. RLS is the security boundary; the email-only view
 // is NOT authentication. Public resources are internet-readable by design.
 const RESOURCE_TABLE='nomad_v53_resources';
 const PUBLIC_BUCKET='nomad-v53-public';
 const PRIVATE_BUCKET='nomad-v53-private';
 const SHARED_KINDS=new Set(['point','doc','countryDoc','photo','activity','countryCoterie']);
 function sharedKind(kind){if(!SHARED_KINDS.has(kind))throw Error('Type de ressource inconnu.');return kind}
 function isPublicRecord(kind,rec){return kind==='photo'||kind==='activity'||rec.public===true}
 function publicAssetUrl(path){
   if(!path)return '';
   return getClient().storage.from(PUBLIC_BUCKET).getPublicUrl(path).data.publicUrl;
 }
 function convertRow(row){
   const obj={...(row.payload||{}),id:row.id};
   obj.public=row.is_public;
   if(row.file_bucket){
     obj.file_bucket=row.file_bucket;obj.file_path=row.file_path;
     obj.data=row.file_bucket===PUBLIC_BUCKET?publicAssetUrl(row.file_path):'';
   }
   return {kind:row.kind,record:obj};
 }
 async function fetchShared(admin=false){
   if(admin && !await isAdmin())throw Error('Accès Gâcheur requis pour consulter les ressources privées.');
   let q=getClient().from(RESOURCE_TABLE).select('id,kind,payload,is_public,file_bucket,file_path').order('updated_at',{ascending:false}).limit(3000);
   // Explicit filter matters even if a technical admin session persists in the browser.
   if(!admin)q=q.eq('is_public',true);
   const {data,error}=await q;
   if(error)throw new Error('Ressources V53 indisponibles : '+report(error)+'. Installez INSTALLER_V53_STOCKAGE_PARTAGE.sql dans Supabase.');
   return (data||[]).map(convertRow);
 }
 async function saveShared(kind,record,file){
   sharedKind(kind);
   if(!await isAdmin())throw Error('Publication réservée au Gâcheur connecté.');
   const id=String(record?.id||'').trim();
   if(!/^[a-zA-Z0-9_-]{2,100}$/.test(id))throw Error('Identifiant de ressource invalide.');
   const isPublic=isPublicRecord(kind,record);
   const payload={...record};
   delete payload.data;delete payload.file_bucket;delete payload.file_path;
   payload.public=isPublic;
   if(JSON.stringify(payload).length>16000)throw Error('Description trop volumineuse.');
   let fileBucket=record.file_bucket||null,filePath=record.file_path||null;
   let freshlyUploaded=false;
   if(file){
     const type=String(file.type||'');
     if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(type))throw Error('Format PDF ou image attendu.');
     if(file.size>4*1024*1024)throw Error('Fichier trop volumineux (maximum 4 Mo).');
     fileBucket=isPublic?PUBLIC_BUCKET:PRIVATE_BUCKET;
     filePath=kind+'/'+id+'-'+(root.crypto?.randomUUID?.()||Date.now().toString(36))+(type==='application/pdf'?'.pdf':type==='image/png'?'.png':type==='image/webp'?'.webp':'.jpg');
     const {error:uploadError}=await getClient().storage.from(fileBucket).upload(filePath,file,{contentType:type,cacheControl:'3600',upsert:false});
     if(uploadError)throw Error('Fichier non transféré : '+report(uploadError));
     freshlyUploaded=true;
   }
   try{
     const row={id,kind,payload,is_public:isPublic,country_id:String(record.countryId||'').slice(0,100)||null,point_id:String(record.pointId||'').slice(0,100)||null,file_bucket:fileBucket,file_path:filePath};
     const {data,error}=await getClient().from(RESOURCE_TABLE).upsert(row,{onConflict:'id'}).select('id,kind,payload,is_public,file_bucket,file_path').single();
     if(error)throw Error('Sauvegarde Supabase refusée : '+report(error));
     return convertRow(data).record;
   }catch(e){
     if(freshlyUploaded)try{await getClient().storage.from(fileBucket).remove([filePath])}catch(_){}
     throw e;
   }
 }
 async function deleteShared(id){
   if(!await isAdmin())throw Error('Suppression réservée au Gâcheur connecté.');
   const {data:old,error:readError}=await getClient().from(RESOURCE_TABLE).select('file_bucket,file_path').eq('id',id).maybeSingle();
   if(readError)throw Error(report(readError));
   const {error}=await getClient().from(RESOURCE_TABLE).delete().eq('id',id);
   if(error)throw Error('Suppression distante refusée : '+report(error));
   // Non-blocking cleanup. A failed deletion of the file must not imply DB deletion failed.
   if(old?.file_bucket&&old?.file_path){
     const {error:fileErr}=await getClient().storage.from(old.file_bucket).remove([old.file_path]);
     if(fileErr)console.warn('Nettoyage du fichier à vérifier',fileErr.message);
   }
   return true;
 }
 async function documentUrl(rec){
   if(!rec?.file_bucket||!rec?.file_path)throw Error('Fichier non disponible sur Supabase Storage.');
   if(rec.file_bucket===PUBLIC_BUCKET)return publicAssetUrl(rec.file_path);
   if(!await isAdmin())throw Error('Document privé : accès réservé au Gâcheur.');
   const {data,error}=await getClient().storage.from(PRIVATE_BUCKET).createSignedUrl(rec.file_path,120);
   if(error)throw Error('Lecture du document impossible : '+report(error));
   return data.signedUrl;
 }

 root.NomadCloud=Object.freeze({ready,submit,signIn,checkPublicEligibility,restore,isAdmin,isCoterie,list,review,listCoteries,setCoterieAccess,requestDeletion,listDeletions,signOut,fetchShared,saveShared,deleteShared,documentUrl});
})(window);
