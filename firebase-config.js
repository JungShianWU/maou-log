// Firebase 網頁設定（公開資訊，不是密碼；存取權限由 firestore.rules 與 Auth 授權網域控管）
export const firebaseConfig = {
  apiKey: "AIzaSyBDEDTsCTmTA5iT-k9bSpcHzUmCiUjjm_w",
  authDomain: "maou-log-jt2c4.firebaseapp.com",
  projectId: "maou-log-jt2c4",
  storageBucket: "maou-log-jt2c4.firebasestorage.app",
  messagingSenderId: "592423934403",
  databaseURL: "https://maou-log-jt2c4-default-rtdb.asia-southeast1.firebasedatabase.app",
  appId: "1:592423934403:web:90b74ac368a76301a98576",
};

// 可以登入編輯的帳號 uid（uid 不是密碼，可公開）。
// 要開放給別人更新時，把對方的 uid 加進來，並同步修改 firestore.rules 的 isEditor()，再執行 firebase deploy --only firestore:rules
export const EDITOR_UIDS = ['F6SSiFKOSzSMDPS91GGHJICiHUg2'];
