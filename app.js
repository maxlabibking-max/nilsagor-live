import { initializeApp } from "https://www.gstatic.com/firebasejs/12.3.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, createUserWithEmailAndPassword,
  signInWithEmailAndPassword, signOut, updateProfile,
  sendPasswordResetEmail, GoogleAuthProvider, signInWithPopup,
  RecaptchaVerifier, signInWithPhoneNumber
} from "https://www.gstatic.com/firebasejs/12.3.0/firebase-auth.js";
import { firebaseConfig, OWNER_EMAIL } from "./firebase-config.js";

const firebaseReady = !Object.values(firebaseConfig).some(v => String(v).includes("PASTE_"));
const fb = firebaseReady ? initializeApp(firebaseConfig) : null;
const auth = fb ? getAuth(fb) : null;

const app = document.querySelector("#app");
let user = null;
let authMode = "login";
let studioTab = "broadcast";
let radioTab = "broadcast";
let countryType = null;
let authBusy = false;
let authRetryUntil = 0;
let phoneConfirmation = null;
let phoneRecaptcha = null;
let phoneMode = false;

// Live TV data is loaded from the public iptv-org API/playlists so countries and channels stay current.
const IPTV_API = "https://iptv-org.github.io/api";
const IPTV_PLAYLIST = "https://iptv-org.github.io/iptv/countries";
let apiCountries = [];
let apiCountryMap = new Map();
const countryCache = new Map();
const apiStreamCache = new Map();
const radioCountryCache = new Map();

async function loadIPTVCountries(){
  if(apiCountries.length) return apiCountries;
  const r = await fetch(`${IPTV_API}/countries.json`, {cache:"no-store"});
  if(!r.ok) throw new Error(`Countries request failed (${r.status})`);
  apiCountries = await r.json();
  apiCountryMap = new Map(apiCountries.map(c => [c.name, c]));
  return apiCountries;
}

async function loadCountryPlaylist(countryName){
  if(countryCache.has(countryName)) return countryCache.get(countryName);
  await loadIPTVCountries();
  const meta = apiCountryMap.get(countryName);
  if(!meta) throw new Error("Country not found in IPTV database");
  const r = await fetch(`${IPTV_PLAYLIST}/${String(meta.code).toLowerCase()}.m3u`, {cache:"no-store"});
  if(!r.ok) throw new Error(`Channel playlist unavailable (${r.status})`);
  const text = await r.text();
  const items = parseM3U(text);
  countryCache.set(countryName, items);
  return items;
}

function parseM3U(text){
  const lines = text.split(/\r?\n/);
  const out=[]; let current=null;
  for(const line0 of lines){
    const line=line0.trim();
    if(line.startsWith('#EXTINF:')){
      const comma=line.indexOf(',');
      const attrs=comma>=0?line.slice(0,comma):line;
      const name=comma>=0?line.slice(comma+1).trim():'Unknown channel';
      const getAttr=(key)=>{const m=attrs.match(new RegExp(`${key}="([^"]*)"`)); return m?m[1]:''};
      current={name, id:getAttr('tvg-id'), logo:getAttr('tvg-logo'), group:getAttr('group-title'), url:'', referrer:''};
    }else if(current && line && !line.startsWith('#')){
      current.url=line; out.push(current); current=null;
    }else if(current && /^#EXTVLCOPT:http-referrer=/i.test(line)){
      current.referrer=line.split('=')[1]||'';
    }
  }
  return out.filter(x=>x.url);
}

const RADIO_API_SERVERS=['https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info','https://at1.api.radio-browser.info'];
async function radioFetch(path){
  let lastErr=null;
  const servers=[...RADIO_API_SERVERS].sort(()=>Math.random()-0.5);
  for(const base of servers){
    try{
      const r=await fetch(base+path,{cache:'no-store',headers:{'Accept':'application/json'}});
      if(r.ok) return r;
      lastErr=new Error(`Radio Browser request failed (${r.status})`);
    }catch(e){ lastErr=e; }
  }
  throw lastErr || new Error('Radio Browser is unavailable');
}
async function loadRadioCountries(){
  return await (await radioFetch('/json/countries?order=stationcount&reverse=true&hidebroken=true')).json();
}
async function loadRadioCountry(countryCode){
  if(radioCountryCache.has(countryCode)) return radioCountryCache.get(countryCode);
  const data=await (await radioFetch(`/json/stations/bycountrycodeexact/${encodeURIComponent(countryCode)}?hidebroken=true&limit=500&order=votes&reverse=true`)).json();
  const items=data.map(x=>({
    name:x.name || 'Unnamed station',
    url:x.url_resolved || x.url || '',
    logo:x.favicon || '', homepage:x.homepage || '',
    codec:x.codec || '', bitrate:x.bitrate || 0, uuid:x.stationuuid || '',
    countrycode:x.countrycode || countryCode
  })).filter(x=>x.url && x.uuid);
  radioCountryCache.set(countryCode,items);
  return items;
}
async function getCountryItems(type,country){
  if(type==='radio'){
    const list=await loadRadioCountries();
    const exact=list.find(c=>String(c.name).toLowerCase()===String(country).toLowerCase());
    const code=exact?.name && /^[A-Za-z]{2}$/.test(exact.name) ? exact.name : countryCodeFromName(country);
    if(!code) throw new Error('Country code not available');
    return loadRadioCountry(code);
  }
  return loadCountryPlaylist(country);
}
function countryCodeFromName(name){
  const map={
    Bangladesh:'BD',India:'IN',Pakistan:'PK',Nepal:'NP','Sri Lanka':'LK','United Arab Emirates':'AE','Saudi Arabia':'SA',
    'United Kingdom':'GB','United States':'US','United States of America':'US',Canada:'CA',Australia:'AU',Malaysia:'MY',Singapore:'SG',Japan:'JP',
    Germany:'DE',France:'FR',Italy:'IT',Spain:'ES',Brazil:'BR',Mexico:'MX',Indonesia:'ID',Thailand:'TH',Philippines:'PH','South Korea':'KR',China:'CN',Turkey:'TR',
    Netherlands:'NL',Austria:'AT',Switzerland:'CH',Sweden:'SE',Norway:'NO',Denmark:'DK',Finland:'FI',Poland:'PL',Russia:'RU',Ukraine:'UA',
    'South Africa':'ZA',Nigeria:'NG',Kenya:'KE',Ghana:'GH',Egypt:'EG',Israel:'IL','New Zealand':'NZ',Ireland:'IE',Portugal:'PT',Greece:'GR',
    Belgium:'BE',Romania:'RO','Czechia':'CZ',Hungary:'HU',Argentina:'AR',Chile:'CL',Colombia:'CO',Peru:'PE',Venezuela:'VE'
  };
  return map[name] || null;
}

function channelCard(item,type,country){
  const safe=encodeURIComponent(item.name);
  return `<div class="channel click" data-channel-name="${safe}" data-channel-type="${type}" data-channel-country="${encodeURIComponent(country)}">
    <div class="channelLogo">${item.logo?`<img src="${item.logo}" alt="" loading="lazy" onerror="this.style.display='none'">`:''}<div class="fallback">${type==='tv'?'TV':'FM'}</div></div>
    <h4>${item.name}</h4><small>${country}</small>${item.codec?`<span class="muted" style="font-size:11px">${item.codec}${item.bitrate?' • '+item.bitrate+' kbps':''}</span>`:''}
  </div>`;
}


const countries = [
  ["Bangladesh","🇧🇩"],["India","🇮🇳"],["Pakistan","🇵🇰"],["Nepal","🇳🇵"],
  ["Sri Lanka","🇱🇰"],["United Arab Emirates","🇦🇪"],["Saudi Arabia","🇸🇦"],
  ["United Kingdom","🇬🇧"],["United States","🇺🇸"],["Canada","🇨🇦"],
  ["Australia","🇦🇺"],["Malaysia","🇲🇾"],["Singapore","🇸🇬"],["Japan","🇯🇵"]
];

// Real/public stream sources. Availability can change at the source provider.
const streamSources = {
  tv: {
    Bangladesh: {
      "Channel I": "https://tvsen6.aynaott.com/channeli/index.m3u8",
      "Jamuna TV": "https://bozztv.com/rongo/rongo-JamunaTelevision/index.m3u8",
      "Somoy News TV": "https://bozztv.com/rongo/rongo-somoy/index.m3u8"
    }
  },
  radio: {
    Bangladesh: {
      "Radio Foorti 88.0 FM": "https://stream.zeno.fm/cwa3vg8s8druv",
      "Radio Today 89.6 FM": "https://stream.zeno.fm/0zha3rfq02quv",
      "Shadin FM": "https://stream.zeno.fm/umq9q5uuva5tv"
    }
  }
};
const sampleTV = {
  Bangladesh:["Channel I","Jamuna TV","Somoy News TV"],
  India:[], "United States":[], "United Kingdom":[]
};
const sampleRadio = {
  Bangladesh:["Radio Foorti 88.0 FM","Radio Today 89.6 FM","Shadin FM"],
  India:[], "United Kingdom":[], "United States":[]
};

function go(path){ location.hash = path; }
function iconLogo(){return `<div class="brandMark">▶</div>`}
function topbar(){
  return `<header class="topbar">
    <button class="iconBtn" id="menuOpen">☰</button>
    <a class="brand" href="#/home">${iconLogo()}NILSAGOR <b>LIVE</b></a>
    <nav class="topnav">
      <button data-route="/home">Home</button><button data-route="/tv">TV</button><button data-route="/radio">Radio</button>
    </nav>
    <button class="avatarBtn" id="accountTop">${user?.photoURL?`<img src="${user.photoURL}">`:"👤"}</button>
  </header>`;
}
function drawer(){
  return `<div class="overlay" id="overlay"></div><aside class="drawer" id="drawer">
    <div class="drawerHead"><b>Nilsagor Live</b><button class="iconBtn" id="menuClose">×</button></div>
    <a href="#/home">🏠 Home</a><a href="#/tv">📺 TV</a><a href="#/radio">📻 Radio</a>
    <div class="drawerLine"></div>
    <a href="#/radio-studio">🎙️ Radio Live Studio</a>
    <a href="#/video-studio">🎥 Video Live Studio</a>
    <a href="#/livecast">📡 Nilsagor LiveCast</a>
    <div class="drawerLine"></div>
    <a href="#/favorites">⭐ Favorites</a><a href="#/history">🕘 History</a><a href="#/notifications">🔔 Notifications</a>
    <a href="#/account">👤 My Account</a>
    ${user?.email?.toLowerCase()===OWNER_EMAIL.toLowerCase()?`<div class="drawerLine"></div><a href="#/admin">👑 Admin</a>`:""}
    <div class="drawerLine"></div>
    <button class="link" id="logoutBtn">🚪 Logout</button>
  </aside>`;
}
function bottom(){
  return `<nav class="bottom">
    <button data-route="/home"><span class="ico">⌂</span>Home</button>
    <button data-route="/tv"><span class="ico">▣</span>TV</button>
    <button data-route="/radio"><span class="ico">◉</span>Radio</button>
    <button data-route="/video-studio"><span class="ico">●</span>Live</button>
    <button id="bottomMenu"><span class="ico">☰</span>Menu</button>
  </nav>`;
}
function shell(body){
  app.innerHTML=`<div class="app">${topbar()}${drawer()}<main class="content">${body}</main>${bottom()}</div>`;
  document.querySelector("#menuOpen").onclick=openMenu;
  document.querySelector("#bottomMenu").onclick=openMenu;
  document.querySelector("#menuClose").onclick=closeMenu;
  document.querySelector("#overlay").onclick=closeMenu;
  document.querySelector("#accountTop").onclick=()=>go("/account");
  document.querySelectorAll("[data-route]").forEach(b=>b.onclick=()=>go(b.dataset.route));
  document.querySelector("#logoutBtn").onclick=async()=>{if(auth) await signOut(auth);};
}
function openMenu(){document.querySelector("#drawer")?.classList.add("open");document.querySelector("#overlay")?.classList.add("show")}
function closeMenu(){document.querySelector("#drawer")?.classList.remove("open");document.querySelector("#overlay")?.classList.remove("show")}

function authScreen(){
  app.innerHTML=`<div class="authWrap"><section class="auth">
    <div class="authBrand">${iconLogo()}<h1>Nilsagor <span class="accent">Live</span></h1><p>TV • Radio • Live</p></div>
    <div class="row" style="margin-bottom:12px"><button class="btn ${authMode==="login"?"":"alt"}" id="loginTab">Login</button><button class="btn ${authMode==="signup"?"":"alt"}" id="signupTab">Sign Up</button></div>
    <div id="authBox"></div>
  </section></div>`;
  document.querySelector("#loginTab").onclick=()=>{authMode="login";authScreen()};
  document.querySelector("#signupTab").onclick=()=>{authMode="signup";authScreen()};
  renderAuthBox();
}
function renderAuthBox(){
  const box=document.querySelector("#authBox");
  if(authMode==="login"){
    box.innerHTML=`<label>Email Address<input id="email" class="input" type="email" autocomplete="email"></label>
    <label>Password<input id="password" class="input" type="password" autocomplete="current-password"></label>
    <div id="authErr"></div><button class="btn block" id="loginBtn" style="margin-top:15px">Login</button>
    <div style="display:flex;align-items:center;gap:9px;margin:14px 0;color:#6f8f98;font-size:12px"><span style="height:1px;background:#1b3943;flex:1"></span>OR<span style="height:1px;background:#1b3943;flex:1"></span></div>
    <button class="btn alt block" id="googleBtn">🔵 Continue with Google</button>
    <button class="btn alt block" id="phoneBtn" style="margin-top:9px">📱 Continue with Phone OTP</button>
    <div class="authLinks"><button class="textBtn" id="forgot">Forgot Password?</button><button class="textBtn" id="toSign">Create account</button></div>`;
    document.querySelector("#loginBtn").onclick=login;
    document.querySelector("#googleBtn").onclick=googleLogin;
    document.querySelector("#phoneBtn").onclick=phoneAuthScreen;
    document.querySelector("#forgot").onclick=forgot;
    document.querySelector("#toSign").onclick=()=>{authMode="signup";authScreen()};
  }else{
    box.innerHTML=`<label>Profile Picture<input id="photo" class="input" type="file" accept="image/*"></label>
    <label>Channel Name<input id="channel" class="input" placeholder="e.g. Labib Live"></label>
    <label>Full Name<input id="name" class="input" placeholder="Your name"></label>
    <label>Age<input id="age" class="input" type="number" min="13" max="120" placeholder="Age"></label>
    <label>Email Address<input id="email" class="input" type="email" autocomplete="email"></label>
    <label>Password<input id="password" class="input" type="password" autocomplete="new-password"></label>
    <label>Confirm Password<input id="confirm" class="input" type="password" autocomplete="new-password"></label>
    <div id="authErr"></div><button class="btn block" id="signupBtn" style="margin-top:15px">Create Account</button>
    <div class="authLinks"><span class="muted">Already have an account?</span><button class="textBtn" id="toLogin">Login</button></div>`;
    document.querySelector("#signupBtn").onclick=signup;
    document.querySelector("#toLogin").onclick=()=>{authMode="login";authScreen()};
  }
}
function err(msg){document.querySelector("#authErr").innerHTML=`<div class="error">${msg}</div>`}
async function login(){
  if(!auth)return err("Add your Firebase Web App config in firebase-config.js first.");
  if(authBusy)return;
  if(Date.now()<authRetryUntil)return err("Firebase is temporarily limiting login attempts. Please wait a few minutes before trying again.");
  const em=document.querySelector("#email")?.value.trim();
  const pw=document.querySelector("#password")?.value||"";
  if(!em)return err("Enter your email address.");
  if(!pw)return err("Enter your password.");
  authBusy=true;
  const btn=document.querySelector("#loginBtn"); if(btn){btn.disabled=true;btn.textContent="Signing in…";}
  try{
    await signInWithEmailAndPassword(auth,em,pw);
  }catch(e){
    if(e?.code==="auth/too-many-requests") authRetryUntil=Date.now()+120000;
    err(cleanFirebaseError(e));
  }finally{
    authBusy=false;
    const b=document.querySelector("#loginBtn"); if(b){b.disabled=false;b.textContent="Login";}
  }
}
async function googleLogin(){
  if(!auth)return err("Add your Firebase Web App config in firebase-config.js first.");
  try{
    const provider=new GoogleAuthProvider();
    provider.setCustomParameters({prompt:"select_account"});
    await signInWithPopup(auth,provider);
  }catch(e){
    if(e?.code==="auth/popup-closed-by-user") return;
    if(e?.code==="auth/popup-blocked") return err("Google popup was blocked. Allow popups for this site and try again.");
    if(e?.code==="auth/unauthorized-domain") return err("Add this website domain to Firebase Authentication → Settings → Authorized domains.");
    err(cleanFirebaseError(e));
  }
}

function phoneAuthScreen(){
  phoneMode=true;
  app.innerHTML=`<div class="authWrap"><section class="auth">
    <div class="authBrand">${iconLogo()}<h1>Phone <span class="accent">Verification</span></h1><p>Sign in with a one-time SMS code</p></div>
    <label>Phone Number<input id="phoneNumber" class="input" type="tel" inputmode="tel" autocomplete="tel" placeholder="+8801XXXXXXXXX"></label>
    <p class="muted" style="font-size:12px">Use international format, for example +8801XXXXXXXXX.</p>
    <div id="recaptcha-container" style="margin:12px 0"></div>
    <div id="phoneErr"></div>
    <button class="btn block" id="sendOtpBtn" style="margin-top:10px">Send OTP</button>
    <div id="otpArea" style="display:none;margin-top:14px">
      <label>6-digit OTP<input id="otpCode" class="input" type="text" inputmode="numeric" maxlength="6" autocomplete="one-time-code" placeholder="Enter SMS code"></label>
      <button class="btn block" id="verifyOtpBtn" style="margin-top:10px">Verify & Continue</button>
    </div>
    <div class="authLinks"><button class="textBtn" id="phoneBack">← Back to Login</button></div>
  </section></div>`;
  document.querySelector("#phoneBack").onclick=()=>{phoneMode=false;authMode="login";authScreen()};
  document.querySelector("#sendOtpBtn").onclick=sendPhoneOtp;
  document.querySelector("#verifyOtpBtn").onclick=verifyPhoneOtp;
  setupPhoneRecaptcha();
}
function phoneError(msg){const el=document.querySelector("#phoneErr");if(el)el.innerHTML=`<div class="error">${msg}</div>`}
function setupPhoneRecaptcha(){
  if(!auth)return phoneError("Firebase is not configured yet.");
  try{
    if(phoneRecaptcha){phoneRecaptcha.clear();phoneRecaptcha=null;}
    phoneRecaptcha=new RecaptchaVerifier(auth,"recaptcha-container",{
      size:"normal",
      callback:()=>{},
      "expired-callback":()=>phoneError("reCAPTCHA expired. Please complete it again.")
    });
    phoneRecaptcha.render();
  }catch(e){phoneError(e?.message||"Could not load reCAPTCHA.");}
}
async function sendPhoneOtp(){
  if(!auth)return phoneError("Add your Firebase Web App config first.");
  const raw=document.querySelector("#phoneNumber")?.value.trim()||"";
  const phone=raw.replace(/[\s()-]/g,"");
  if(!/^\+[1-9]\d{7,14}$/.test(phone))return phoneError("Enter a valid phone number with country code, such as +8801XXXXXXXXX.");
  const btn=document.querySelector("#sendOtpBtn");
  try{
    if(!phoneRecaptcha)setupPhoneRecaptcha();
    btn.disabled=true;btn.textContent="Sending OTP…";
    phoneConfirmation=await signInWithPhoneNumber(auth,phone,phoneRecaptcha);
    document.querySelector("#otpArea").style.display="block";
    phoneError("OTP sent. Check your SMS and enter the 6-digit code.");
  }catch(e){
    phoneConfirmation=null;
    try{if(phoneRecaptcha)await phoneRecaptcha.render();}catch{}
    if(e?.code==="auth/too-many-requests")phoneError("Too many verification attempts. Please wait and try again, or use a Firebase test phone number during development.");
    else if(e?.code==="auth/operation-not-allowed")phoneError("Enable Phone sign-in in Firebase Authentication first.");
    else if(e?.code==="auth/unauthorized-domain")phoneError("Add this website domain to Firebase Authentication → Settings → Authorized domains.");
    else phoneError(cleanFirebaseError(e));
  }finally{btn.disabled=false;btn.textContent="Send OTP";}
}
async function verifyPhoneOtp(){
  if(!phoneConfirmation)return phoneError("Send an OTP first.");
  const code=(document.querySelector("#otpCode")?.value||"").trim();
  if(!/^\d{6}$/.test(code))return phoneError("Enter the 6-digit OTP from your SMS.");
  const btn=document.querySelector("#verifyOtpBtn");
  try{btn.disabled=true;btn.textContent="Verifying…";await phoneConfirmation.confirm(code);phoneConfirmation=null;}
  catch(e){phoneError(e?.code==="auth/invalid-verification-code"?"The OTP is incorrect. Please try again.":e?.code==="auth/code-expired"?"The OTP expired. Send a new code.":cleanFirebaseError(e));}
  finally{btn.disabled=false;btn.textContent="Verify & Continue";}
}
async function forgot(){
  if(!auth)return err("Firebase is not configured yet.");
  if(authBusy)return;
  const em=document.querySelector("#email")?.value.trim();
  if(!em)return err("Enter your email first.");
  authBusy=true;
  const btn=document.querySelector("#forgot"); if(btn)btn.disabled=true;
  try{await sendPasswordResetEmail(auth,em);err("Password reset email sent. Check your inbox.")}
  catch(e){if(e?.code==="auth/too-many-requests")authRetryUntil=Date.now()+120000;err(cleanFirebaseError(e))}
  finally{authBusy=false;const b=document.querySelector("#forgot");if(b)b.disabled=false;}
}
async function signup(){
  if(!auth)return err("Add your Firebase Web App config in firebase-config.js first.");
  if(password.value!==confirm.value)return err("Passwords do not match.");
  if(!channel.value.trim()||!name.value.trim())return err("Channel name and full name are required.");
  if(!age.value || Number(age.value)<13)return err("Please enter a valid age.");
  try{
    const cred=await createUserWithEmailAndPassword(auth,email.value.trim(),password.value);
    await updateProfile(cred.user,{displayName:channel.value.trim()});
    localStorage.setItem("nilsagor_profile",JSON.stringify({channel:channel.value.trim(),name:name.value.trim(),age:Number(age.value)}));
  }catch(e){err(cleanFirebaseError(e))}
}
function cleanFirebaseError(e){
  const m=e?.code||"";
  if(m.includes("email-already-in-use"))return"Email is already registered.";
  if(m.includes("invalid-credential"))return"Email or password is incorrect.";
  if(m.includes("too-many-requests"))return"Firebase has temporarily blocked repeated login attempts. Please wait a few minutes, then try again. If you forgot the password, use Forgot Password.";
  if(m.includes("weak-password"))return"Password should be at least 6 characters.";
  if(m.includes("invalid-email"))return"Please enter a valid email.";
  return e?.message||"Something went wrong.";
}

function home(){
  shell(`<section class="hero"><h1>Your world, <span class="accent">Live.</span></h1><p>TV, radio and user live streaming in one place.</p></section>
  <section class="heroLive"><div class="visual"><span class="liveBadge">LIVE</span><div><div style="font-size:55px">📡</div><h2>User Live</h2><p>No user is live right now.</p></div></div>
  <div class="liveInfo"><span class="pill">Nilsagor Live</span><h2>Watch FM & TV live</h2><p>Explore country-wise channels and stations.</p><div class="row"><button class="btn" onclick="go('/tv')">TV</button><button class="btn alt" onclick="go('/radio')">Radio</button></div></div></section>
  <section class="section"><div class="sectionTitle"><h2>Explore</h2></div><div class="grid grid3">
  <div class="card click serviceCard" onclick="go('/tv')"><div class="serviceIcon">📺</div><h3>Live TV</h3><p>Bangladesh first, then country-wise channels.</p></div>
  <div class="card click serviceCard" onclick="go('/radio')"><div class="serviceIcon">📻</div><h3>Live Radio</h3><p>FM stations organized by country.</p></div>
  <div class="card click serviceCard" onclick="go('/livecast')"><div class="serviceIcon">📡</div><h3>Nilsagor LiveCast</h3><p>Broadcast from CameraFi, OBS or any RTMP app.</p></div>
  </div></section>`);
}
async function countriesPage(type){
  shell(`<div class="sectionTitle"><div><h2>🌍 Countries</h2><p class="muted">Loading countries and live ${type==='radio'?'radio stations':'TV channels'}…</p></div></div><div id="countryList" class="countryGrid" style="margin-top:15px"><div class="notice">Loading…</div></div>`);
  try{
    let sorted;
    if(type==='radio'){
      const list=await loadRadioCountries();
      sorted=list.filter(c=>Number(c.stationcount)>0).map(c=>({name:c.name,code:countryCodeFromName(c.name),stationcount:Number(c.stationcount),flag:flagForCode(c.name)})).filter(c=>c.code).sort((a,b)=>a.name.localeCompare(b.name));
    }else{
      const list=await loadIPTVCountries();
      sorted=[...list].sort((a,b)=>a.name.localeCompare(b.name));
    }
    const el=document.querySelector('#countryList');
    el.innerHTML=sorted.map(c=>`<button class="country" data-country-code="${c.code}" data-country-name="${encodeURIComponent(c.name)}">${c.flag||'🌍'} ${c.name}</button>`).join('');
    el.querySelectorAll('[data-country-name]').forEach(b=>b.onclick=()=>listChannels(type,decodeURIComponent(b.dataset.countryName)));
    if(!sorted.length) el.innerHTML='<div class="empty">No countries with available stations were returned.</div>';
  }catch(e){
    document.querySelector('#countryList').innerHTML=`<div class="error">Could not load country list. ${e.message||''}</div>`;
  }
}
function flagForCode(name){
  const code=countryCodeFromName(name);
  if(code) return code.toUpperCase().replace(/./g,c=>String.fromCodePoint(127397+c.charCodeAt(0)));
  return '🌍';
}
function chooseType(type){countryType=type;shell(`<h2>${type==='tv'?'📺 TV':'📻 Radio'}</h2><p class="muted">Choose Bangladesh or browse every available country.</p>
<div class="grid" style="margin-top:15px"><div class="card click" id="bdOpen"><h3>🇧🇩 Bangladesh ${type==='tv'?'Channels':'Radio'}</h3><p>Load the latest public ${type==='tv'?'TV channels':'radio stations'}.</p></div><div class="card click" id="countryOpen"><h3>🌍 Country</h3><p>Choose any country from the live database.</p></div></div>`);
  document.querySelector('#bdOpen').onclick=()=>listChannels(type,'Bangladesh');
  document.querySelector('#countryOpen').onclick=()=>countriesPage(type);
}
function tv(){chooseType('tv')} function radio(){chooseType('radio')}
window.countriesPage=countriesPage;
async function listChannels(type,country){
  shell(`<div class="sectionTitle"><div><h2>${flag(country)} ${country} ${type==='tv'?'TV Channels':'Radio Stations'}</h2><p class="muted">Loading live sources…</p></div><button class="btn alt" id="changeCountry">Change Country</button></div><div id="channelList" class="channelGrid"><div class="notice">Loading…</div></div>`);
  document.querySelector('#changeCountry').onclick=()=>countriesPage(type);
  try{
    const arr=await getCountryItems(type,country);
    const el=document.querySelector('#channelList');
    if(!arr.length){el.innerHTML=`<div class="empty">No public streams are currently listed for ${country}.</div>`;return;}
    el.innerHTML=arr.map(x=>channelCard(x,type,country)).join('');
    el.querySelectorAll('[data-channel-name]').forEach(card=>card.onclick=()=>{
      const name=decodeURIComponent(card.dataset.channelName);
      const item=arr.find(x=>x.name===name);
      openStation(type,name,item?.url||'',item?.referrer||'',item?.logo||'');
    });
  }catch(e){
    document.querySelector('#channelList').innerHTML=`<div class="error">Could not load ${country} channels right now. ${e.message||''}</div>`;
  }
}
function flag(c){return apiCountryMap.get(c)?.flag || (countries.find(x=>x[0]===c)||['','🌍'])[1]}
window.openStation=(type,name,src='',referrer='',logo='')=>{
  shell(`<div class="sectionTitle"><div><h2>${type==='tv'?'📺':'📻'} ${name}</h2><p class="muted">Live player</p></div><button class="btn alt" id="playerBack">Back</button></div>
  <div class="player">${type==='tv'?`<video id="liveVideo" controls playsinline style="width:100%;max-height:70vh;background:#000"></video>`:`<div class="playerAudio"><div style="font-size:50px">🎵</div><h2>${name}</h2><audio id="liveAudio" controls playsinline style="width:100%"></audio></div>`}</div>
  <div id="playStatus" class="notice">Preparing stream…</div>
  <div class="row" style="margin-top:12px"><button class="btn" id="playAgain">▶ Play</button><button class="btn alt" id="openSource">↗ Open source</button></div>`);
  document.querySelector('#playerBack').onclick=()=>go(`/${type}`);
  const status=document.querySelector('#playStatus'); const playAgain=document.querySelector('#playAgain'); const openSource=document.querySelector('#openSource');
  if(!src){status.textContent='No stream URL is available for this channel.';playAgain.disabled=true;openSource.disabled=true;return;}
  openSource.onclick=()=>window.open(src,'_blank','noopener');
  const start=async()=>{
    if(type==='radio'){
      const a=document.querySelector('#liveAudio');
      let playSrc=src;
      try{
        if(logo && /^https?:/i.test(src)){ /* keep direct resolved URL when available */ }
      }catch{}
      a.src=playSrc; a.load();
      a.onplaying=()=>status.textContent='🟢 LIVE — playing now.';
      a.onerror=()=>status.textContent='⚠️ This station stream cannot be played in this browser. It may require HTTPS or the source may be offline.';
      a.play().catch(()=>status.textContent='Tap Play to start the station.');
      playAgain.onclick=()=>a.play().catch(()=>{});
    }else{
      const v=document.querySelector('#liveVideo');
      if(window.Hls && Hls.isSupported() && /\.m3u8(\?|$)/i.test(src)){
        if(v._hls) v._hls.destroy(); const h=new Hls({enableWorker:true}); v._hls=h; h.loadSource(src); h.attachMedia(v);
        h.on(Hls.Events.MANIFEST_PARSED,()=>{status.textContent='🟢 Stream connected — press Play if autoplay is blocked.';v.play().catch(()=>{});});
        h.on(Hls.Events.ERROR,(_,d)=>{if(d.fatal)status.textContent='⚠️ Stream is unavailable here (source may be offline, geo-blocked, or block browser playback). Try Open source.';});
      }else{v.src=src;v.play().catch(()=>{});v.onplaying=()=>status.textContent='🟢 LIVE — playing now.';v.onerror=()=>status.textContent='⚠️ Stream could not be played in this browser.';}
      playAgain.onclick=()=>v.play();
    }
  };
  start();
}

function radioStudio(){
  shell(`<div class="studioTop"><div><h2>🎙️ Radio Live Studio</h2><p class="muted">Broadcast • Mixer • Tracks</p></div><span id="radioStatus" class="pill">OFF AIR</span></div>
  <div class="studioPreview"><div><div style="font-size:58px">🎙️</div><h2 id="radioTimer">00:00:00</h2><p id="studioNow" class="muted">Ready to broadcast</p></div></div>
  <div class="studioTabs"><button class="btn ${radioTab==="broadcast"?"":"alt"}" onclick="radioStudioTab('broadcast')">📻 Broadcast</button><button class="btn ${radioTab==="mixer"?"":"alt"}" onclick="radioStudioTab('mixer')">🎚️ Mixer</button><button class="btn ${radioTab==="tracks"?"":"alt"}" onclick="radioStudioTab('tracks')">🎵 Tracks</button></div>
  <div id="radioStudioBody"></div>`);
  radioStudioTab(radioTab);
}

let radioLive=false, radioStart=0, radioTimerHandle=null;
let studioTracks=[];
let studioTrackIndex=-1;
let studioAudio=null;
let studioObjectUrls=[];
let studioMusicVolume=0.70;
let studioMasterVolume=0.85;
let studioMicVolume=0.80;
let studioRecording=null;
let studioRecordingChunks=[];

function ensureStudioAudio(){
  if(!studioAudio){
    studioAudio=new Audio();
    studioAudio.preload='metadata';
    studioAudio.onloadedmetadata=()=>updateTrackUI();
    studioAudio.ontimeupdate=()=>updateTrackUI();
    studioAudio.onplay=()=>updateTrackUI();
    studioAudio.onpause=()=>updateTrackUI();
    studioAudio.onended=()=>{
      if(studioTracks.length){
        if(studioTrackIndex < studioTracks.length-1) playStudioTrack(studioTrackIndex+1);
        else { studioTrackIndex=-1; updateTrackUI(); }
      }
    };
    studioAudio.onerror=()=>{const st=document.querySelector('#trackStatus'); if(st) st.textContent='⚠️ This audio file could not be played.';};
  }
  studioAudio.volume=Math.max(0,Math.min(1,studioMusicVolume*studioMasterVolume));
  return studioAudio;
}

function formatTime(sec){
  if(!Number.isFinite(sec)) return '00:00';
  sec=Math.max(0,Math.floor(sec));
  const m=Math.floor(sec/60), s=sec%60;
  return String(m).padStart(2,'0')+':'+String(s).padStart(2,'0');
}
function escapeHtml(v){return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function updateTrackUI(){
  const list=document.querySelector('#trackList');
  if(list) list.innerHTML=studioTracks.length ? studioTracks.map((t,i)=>`<div class="trackRow ${i===studioTrackIndex?'active':''}"><div class="trackMeta"><b>${escapeHtml(t.name)}</b><small>${formatTime(t.duration)}${i===studioTrackIndex && studioAudio ? ` • ${formatTime(studioAudio.currentTime)}`:''}</small></div><div class="trackActions"><button class="btn mini" onclick="playStudioTrack(${i})">${i===studioTrackIndex && studioAudio && !studioAudio.paused?'⏸':'▶'}</button><button class="btn mini alt" onclick="removeStudioTrack(${i})">🗑</button></div></div>`).join('') : '<div class="empty">No tracks added. Choose MP3, M4A, WAV or another supported audio file.</div>';
  const now=document.querySelector('#studioNow');
  if(now) now.textContent=studioTrackIndex>=0 && studioTracks[studioTrackIndex] ? `🎵 ${studioTracks[studioTrackIndex].name}` : 'Ready to broadcast';
  const np=document.querySelector('#np');
  if(np) np.textContent=studioTrackIndex>=0 && studioTracks[studioTrackIndex] ? studioTracks[studioTrackIndex].name : 'No Track Playing';
  const pos=document.querySelector('#trackSeek');
  if(pos && studioAudio && Number.isFinite(studioAudio.duration) && studioAudio.duration>0) pos.value=(studioAudio.currentTime/studioAudio.duration)*100;
  const time=document.querySelector('#trackTime');
  if(time && studioAudio) time.textContent=`${formatTime(studioAudio.currentTime)} / ${formatTime(studioAudio.duration)}`;
}
function playStudioTrack(i){
  if(!studioTracks[i]) return;
  const a=ensureStudioAudio();
  studioTrackIndex=i;
  a.src=studioTracks[i].url;
  a.volume=Math.max(0,Math.min(1,studioMusicVolume*studioMasterVolume));
  a.load();
  a.play().then(()=>{const st=document.querySelector('#trackStatus');if(st)st.textContent='🟢 Playing';updateTrackUI();}).catch(()=>{const st=document.querySelector('#trackStatus');if(st)st.textContent='Tap Play again to start this track.';updateTrackUI();});
}
function toggleStudioTrack(){
  if(studioTrackIndex<0){if(studioTracks.length) playStudioTrack(0);return;}
  const a=ensureStudioAudio();
  if(a.paused) a.play().then(updateTrackUI).catch(()=>{}); else a.pause();
  updateTrackUI();
}
function nextStudioTrack(){if(studioTracks.length) playStudioTrack((studioTrackIndex+1+studioTracks.length)%studioTracks.length);}
function prevStudioTrack(){
  if(!studioTracks.length)return;
  if(studioAudio && studioAudio.currentTime>3){studioAudio.currentTime=0;return;}
  playStudioTrack((studioTrackIndex-1+studioTracks.length)%studioTracks.length);
}
function removeStudioTrack(i){
  if(!studioTracks[i])return;
  const was=studioTrackIndex===i;
  if(studioTracks[i].url.startsWith('blob:')) URL.revokeObjectURL(studioTracks[i].url);
  studioTracks.splice(i,1);
  if(!studioTracks.length){studioTrackIndex=-1;if(studioAudio){studioAudio.pause();studioAudio.removeAttribute('src');studioAudio.load();}}
  else if(was){studioTrackIndex=Math.min(i,studioTracks.length-1);playStudioTrack(studioTrackIndex);}
  else if(i<studioTrackIndex)studioTrackIndex--;
  updateTrackUI();
}
function addStudioFiles(files){
  [...files].filter(f=>f.type.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg|opus|flac)$/i.test(f.name)).forEach(file=>{
    const url=URL.createObjectURL(file); studioObjectUrls.push(url);
    studioTracks.push({name:file.name,url,duration:0,size:file.size});
    const ix=studioTracks.length-1;
    const probe=new Audio(); probe.preload='metadata'; probe.src=url; probe.onloadedmetadata=()=>{if(studioTracks[ix]){studioTracks[ix].duration=probe.duration;updateTrackUI();}};
  });
  updateTrackUI();
}
function setStudioVolume(kind,val){
  const n=Number(val)/100;
  if(kind==='music')studioMusicVolume=n;
  if(kind==='master')studioMasterVolume=n;
  if(kind==='mic')studioMicVolume=n;
  if(studioAudio)studioAudio.volume=Math.max(0,Math.min(1,studioMusicVolume*studioMasterVolume));
  const out=document.querySelector(`#${kind}Val`);if(out)out.textContent=Math.round(n*100)+'%';
}
function renderTracksTab(b){
  b.innerHTML=`<div class="studioGrid"><div class="panel"><h3>🎵 Tracks</h3>
    <label class="fileDrop">➕ Add audio tracks<input id="trackFile" class="input" type="file" accept="audio/*,.mp3,.m4a,.wav,.aac,.ogg,.opus,.flac" multiple></label>
    <div class="row" style="margin-top:12px"><button class="btn" onclick="prevStudioTrack()">⏮ Previous</button><button class="btn" onclick="toggleStudioTrack()">▶ / ⏸ Play</button><button class="btn" onclick="nextStudioTrack()">Next ⏭</button></div>
    <input id="trackSeek" class="range" type="range" min="0" max="100" value="0" style="width:100%;margin-top:14px">
    <div class="row" style="justify-content:space-between"><span id="trackStatus" class="muted">Ready</span><span id="trackTime" class="muted">00:00 / 00:00</span></div>
    <div id="trackList" style="margin-top:12px"></div>
  </div><div class="panel"><h3>Playlist</h3><p class="muted">Tracks are played locally in this browser. They are not uploaded publicly.</p><div class="notice">Tip: tap a track's ▶ button to play it. When one ends, the next track starts automatically.</div></div></div>`;
  document.querySelector('#trackFile').onchange=e=>addStudioFiles(e.target.files);
  document.querySelector('#trackSeek').oninput=e=>{if(studioAudio && Number.isFinite(studioAudio.duration))studioAudio.currentTime=(Number(e.target.value)/100)*studioAudio.duration;};
  updateTrackUI();
}
function renderMixerTab(b){
  b.innerHTML=`<div class="studioGrid"><div class="panel"><h3>🎚️ Master Console</h3>
    <div class="fader"><b>Mic</b><input id="micRange" class="range" type="range" min="0" max="100" value="${Math.round(studioMicVolume*100)}" oninput="setStudioVolume('mic',this.value)"><span id="micVal">${Math.round(studioMicVolume*100)}%</span></div>
    <div class="fader"><b>Music</b><input id="musicRange" class="range" type="range" min="0" max="100" value="${Math.round(studioMusicVolume*100)}" oninput="setStudioVolume('music',this.value)"><span id="musicVal">${Math.round(studioMusicVolume*100)}%</span></div>
    <div class="fader"><b>Master</b><input id="masterRange" class="range" type="range" min="0" max="100" value="${Math.round(studioMasterVolume*100)}" oninput="setStudioVolume('master',this.value)"><span id="masterVal">${Math.round(studioMasterVolume*100)}%</span></div>
    </div><div class="panel"><h3>Pro Broadcast FX</h3><div class="chips">${["Auto Ducking","Noise Gate","Compressor","10-Band EQ","Bass Boost","Mic Boost","Virtualizer","Reverb","Voice FX","Jingle Pads"].map(x=>`<button class="chip" onclick="this.classList.toggle('on')">${x}</button>`).join("")}</div></div></div>`;
}
async function toggleStudioRecording(){
  const btn=document.querySelector('#radioRec');
  if(studioRecording){studioRecording.stop();return;}
  if(!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder){alert('Audio recording is not supported by this browser.');return;}
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    studioRecordingChunks=[];
    studioRecording=new MediaRecorder(stream);
    studioRecording.ondataavailable=e=>{if(e.data.size)studioRecordingChunks.push(e.data);};
    studioRecording.onstop=()=>{
      const blob=new Blob(studioRecordingChunks,{type:studioRecording.mimeType||'audio/webm'});
      const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=`nilsagor-recording-${new Date().toISOString().replace(/[:.]/g,'-')}.webm`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
      stream.getTracks().forEach(t=>t.stop());studioRecording=null;studioRecordingChunks=[];if(btn)btn.textContent='⏺ Start Recording';
    };
    studioRecording.start();if(btn)btn.textContent='⏹ Stop & Save';
  }catch(e){alert('Microphone permission is required for recording.');}
}
window.radioStudioTab=(t)=>{radioTab=t;const b=document.querySelector('#radioStudioBody');if(!b)return;
  if(t==='broadcast'){
    b.innerHTML=`<div class="studioGrid"><div class="panel"><h3>Broadcast</h3><div class="row"><button class="btn" id="radioGo">🔴 GO LIVE</button><button class="btn alt" id="radioRec">⏺ Start Recording</button></div><div class="section"><span class="pill">Local Studio</span></div><div class="notice" style="margin-top:12px">GO LIVE changes the local studio state. Public listener distribution still requires a connected streaming backend such as Icecast/Shoutcast/LiveKit.</div></div><div class="panel"><h3>Currently Playing</h3><h3 id="np">No Track Playing</h3><div class="row"><button class="btn alt" onclick="prevStudioTrack()">↶</button><button class="btn" onclick="toggleStudioTrack()">▶</button><button class="btn alt" onclick="nextStudioTrack()">↷</button></div><div class="meter" style="margin-top:15px"><i></i></div></div></div>`;
    document.querySelector('#radioGo').onclick=toggleRadioLive;document.querySelector('#radioRec').onclick=toggleStudioRecording;updateTrackUI();
  } else if(t==='mixer') renderMixerTab(b); else renderTracksTab(b);
};
function toggleRadioLive(){radioLive=!radioLive;const s=document.querySelector('#radioStatus'),b=document.querySelector('#radioGo');if(radioLive){radioStart=Date.now();if(s){s.className='pill live';s.textContent='ON AIR'}if(b)b.textContent='🛑 END LIVE';clearInterval(radioTimerHandle);radioTimerHandle=setInterval(()=>{const ms=Date.now()-radioStart;const t=document.querySelector('#radioTimer');if(t)t.textContent=new Date(ms).toISOString().slice(11,19)},1000)}else{clearInterval(radioTimerHandle);if(s){s.className='pill';s.textContent='OFF AIR'}if(b)b.textContent='🔴 GO LIVE';const t=document.querySelector('#radioTimer');if(t)t.textContent='00:00:00'}}
function videoStudio(){
  shell(`<div class="studioTop"><div><h2>🎥 Video Live Studio</h2><p class="muted">Camera • YouTube/Facebook public live • External Live</p></div><span id="videoStatus" class="pill">OFFLINE</span></div>
  <div class="studioPreview video"><video id="camPreview" autoplay muted playsinline></video><div id="camEmpty"><div style="font-size:58px">📷</div><b>Camera Preview</b><p class="muted">Start camera when ready</p></div></div>
  <div class="studioControls"><button class="round" id="flipBtn">↔</button><button class="round" id="muteCam">🎙️</button><button class="round main" id="cameraBtn">●</button><button class="round" id="hideVideo">▣</button><button class="round" id="shareVideo">↗</button></div>
  <div class="studioTabs"><button class="btn ${studioTab==="broadcast"?"":"alt"}" onclick="videoStudioTab('broadcast')">📹 Camera Live</button><button class="btn ${studioTab==="sources"?"":"alt"}" onclick="videoStudioTab('sources')">🌐 YouTube / Facebook</button><button class="btn ${studioTab==="effects"?"":"alt"}" onclick="videoStudioTab('effects')">✨ Effects</button></div>
  <div id="videoBody"></div>`);
  videoStudioTab(studioTab); setupCamera();
}
let camStream=null, facing="user";
async function setupCamera(){document.querySelector("#cameraBtn").onclick=async()=>{if(camStream){camStream.getTracks().forEach(t=>t.stop());camStream=null;document.querySelector("#camPreview").srcObject=null;document.querySelector("#camEmpty").style.display="block";document.querySelector("#videoStatus").textContent="OFFLINE";document.querySelector("#videoStatus").className="pill";return}try{camStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:facing},audio:true});document.querySelector("#camPreview").srcObject=camStream;document.querySelector("#camEmpty").style.display="none";document.querySelector("#videoStatus").textContent="CAMERA READY";document.querySelector("#videoStatus").className="pill green"}catch(e){alert("Camera/microphone permission is required.")}}};
document.querySelector;
window.videoStudioTab=(t)=>{studioTab=t;const b=document.querySelector("#videoBody");if(!b)return;
if(t==="broadcast")b.innerHTML=`<div class="panel"><h3>Go Live</h3><p class="muted">Your browser camera preview is local. Public distribution uses Nilsagor LiveCast/RTMP backend.</p><div class="row"><button class="btn" onclick="alert('Configure Nilsagor LiveCast first, then publish this camera stream.')">🔴 GO LIVE</button><button class="btn alt" onclick="alert('Practice mode: camera preview only.')">Practice Mode</button></div></div>`;
else if(t==="sources")b.innerHTML=`<div class="panel"><h3>🌐 Live Sources</h3><label>YouTube public/embed URL<input id="ytUrl" class="input" placeholder="https://youtube.com/..."></label><label>Facebook public/embed URL<input id="fbUrl" class="input" placeholder="https://facebook.com/..."></label><button class="btn" onclick="previewExternal()">Show Preview</button><div id="externalPreview" style="margin-top:12px"></div><div class="notice" style="margin-top:12px">Only public/embed-allowed content can be shown. Login-required or blocked streams cannot be bypassed.</div></div>`;
else b.innerHTML=`<div class="panel"><h3>✨ Camera Controls</h3><div class="chips">${["Portrait","Landscape","Lighting","Retouch","Effects","Mic","Hide Live Video"].map(x=>`<button class="chip" onclick="this.classList.toggle('on')">${x}</button>`).join("")}</div></div>`;
}
window.previewExternal=()=>{const url=(document.querySelector("#ytUrl")?.value||document.querySelector("#fbUrl")?.value||"").trim();if(!url)return;document.querySelector("#externalPreview").innerHTML=`<div class="player"><iframe src="${url.replace(/"/g,"&quot;")}" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>`}
window.flipCamera=()=>{};
function livecast(){shell(`<div class="hero"><h1>📡 Nilsagor <span class="accent">LiveCast</span></h1><p>Go live from CameraFi, OBS or any RTMP-compatible broadcaster.</p></div>
<div class="grid"><div class="card"><h3>1. Server URL</h3><input class="input" value="rtmp://YOUR-NILSAGOR-SERVER/live" readonly><button class="btn alt" onclick="navigator.clipboard?.writeText('rtmp://YOUR-NILSAGOR-SERVER/live')">Copy</button></div>
<div class="card"><h3>2. Stream Key</h3><input class="input" value="YOUR-STREAM-KEY" readonly><button class="btn alt" onclick="navigator.clipboard?.writeText('YOUR-STREAM-KEY')">Copy</button></div>
<div class="card"><h3>3. Broadcast App</h3><p>Use CameraFi, OBS or another RTMP-compatible app and enter the server + key.</p></div></div>
<div class="panel" style="margin-top:14px"><h3>Important</h3><p class="muted">A real RTMP ingest server and transcoding/distribution backend are required before external apps can publish to Nilsagor viewers. This page does not fake a live connection.</p></div>`)}
function simple(name){shell(`<div class="empty"><h2>${name[0]?.toUpperCase()+name.slice(1)}</h2><p>This section is ready in the new navigation and can be connected to Firebase data next.</p></div>`)}
function account(){const p=JSON.parse(localStorage.getItem("nilsagor_profile")||"{}");shell(`<div class="hero"><h1>My Account</h1><p>${user?.email||""}</p></div><div class="card"><h3>${p.channel||user?.displayName||"Your Channel"}</h3><p>${p.name||""}${p.age?` • Age ${p.age}`:""}</p><div class="row" style="margin-top:15px"><button class="btn danger" id="accLogout">Logout</button></div></div>`);document.querySelector("#accLogout").onclick=()=>auth&&signOut(auth)}
function admin(){shell(`<div class="hero"><h1>👑 Admin</h1><p>Owner-only area.</p></div><div class="card"><h3>Owner</h3><p>${OWNER_EMAIL}</p><p class="muted">Channel management, users, live sessions and moderation can be connected here.</p></div>`)}
function route(){
  const p=location.hash.slice(1)||"/home";
  if(!user){authScreen();return}
  if(p==="/home"||p==="/")home();
  else if(p==="/tv")tv();
  else if(p==="/radio")radio();
  else if(p.startsWith("/tv/country/")){ listChannels("tv",decodeURIComponent(p.slice(12))); }
  else if(p.startsWith("/radio/country/")){ listChannels("radio",decodeURIComponent(p.slice(15))); }
  else if(p==="/tv/Bangladesh"){ listChannels("tv","Bangladesh"); }
  else if(p==="/radio/Bangladesh"){ listChannels("radio","Bangladesh"); }else if(p==="/radio-studio")radioStudio();else if(p==="/video-studio")videoStudio();else if(p==="/livecast")livecast();else if(p==="/account")account();else if(p==="/admin" && user.email?.toLowerCase()===OWNER_EMAIL.toLowerCase())admin();else simple(p.replace("/",""));
}

// Robust navigation for dynamic country/channel cards.
// Reliable station-card click handling.
document.addEventListener("click", (e)=>{
  const card=e.target.closest("[data-station-type]");
  if(card){ e.preventDefault(); openStation(card.dataset.stationType, decodeURIComponent(card.dataset.stationName)); }
});

document.addEventListener("click", (e)=>{
  const el=e.target.closest("[data-href]");
  if(el){ e.preventDefault(); go(el.getAttribute("data-href")); }
});

// SPA navigation fix: hash changes must re-render the current page.
window.addEventListener("hashchange", route);

// Inline controls inside dynamically-rendered pages need global handlers.
window.go=go;
window.countriesPage=countriesPage;
window.listChannels=listChannels;
window.openStation=openStation;
window.radioStudio=radioStudio;
window.videoStudio=videoStudio;
window.livecast=livecast;

if(auth){
  onAuthStateChanged(auth,u=>{user=u;route()});
}else{
  user=null;authScreen();
}
