/**
 * ════════════════════════════════════════════════════════════════════
 *  GabOS — Cloud Function « icsFeed »  (ABONNEMENT CALENDRIER .ics)
 * ════════════════════════════════════════════════════════════════════
 *
 *  ⚠️  CE FICHIER N'EST PAS ENCORE DÉPLOYÉ — c'est une PRÉPARATION.
 *      Tant qu'il n'est pas déployé sur Firebase, l'app GabOS n'affiche
 *      QUE l'export manuel .ics (l'abonnement automatique reste masqué).
 *
 *  Cette fonction expose une URL HTTP publique qui génère un flux
 *  iCalendar (.ics) à la volée à partir des données Firestore de
 *  l'utilisateur. Elle est protégée par un token aléatoire (et NON par
 *  l'uid brut) : l'app génère ce token et le stocke dans le profil
 *  utilisateur (champ `icsToken`), puis construit l'URL :
 *
 *      https://<region>-<projet>.cloudfunctions.net/icsFeed?token=<token>
 *
 *  ────────────────────────────────────────────────────────────────────
 *  POUR L'ACTIVER (étape de config Firebase, à faire de ton côté) :
 *
 *   1. Dans le dossier du projet :   firebase init functions
 *      (choisis JavaScript ; garde/installe les dépendances proposées)
 *   2. Remplace le functions/index.js généré par CE fichier.
 *   3. Déploie :                     firebase deploy --only functions
 *   4. Firebase affiche l'URL de la fonction, par ex. :
 *        https://us-central1-gabos-3d3e8.cloudfunctions.net/icsFeed
 *      Copie la partie de BASE (sans /icsFeed) dans index.html :
 *        const ICS_FEED_BASE = "https://us-central1-gabos-3d3e8.cloudfunctions.net";
 *   5. Recharge GabOS : la carte « Abonnement automatique » apparaît.
 *
 *  Remarque : l'abonnement est en LECTURE SEULE (Apple/Google lisent ce
 *  flux mais n'écrivent jamais dans GabOS).
 * ════════════════════════════════════════════════════════════════════
 */

const functions = require("firebase-functions");
const admin = require("firebase-admin");

admin.initializeApp();

// ─── Génération iCalendar (miroir de buildICS() côté index.html) ───
function icsEscape(s) {
  return String(s == null ? "" : s)
    .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
}
const icsDate = (dateStr) => dateStr.replace(/-/g, "");
const icsDateTime = (dateStr, timeStr) => icsDate(dateStr) + "T" + (timeStr || "00:00").replace(":", "") + "00";

function addDayStr(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d, 12, 0, 0, 0);
  dt.setDate(dt.getDate() + 1);
  const p = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function icsRRule(ev) {
  const map = { daily: "DAILY", weekly: "WEEKLY", monthly: "MONTHLY" };
  const freq = map[ev.recurrence];
  if (!freq) return "";
  let r = "RRULE:FREQ=" + freq;
  if (ev.recurrenceEnd) r += ";UNTIL=" + icsDate(ev.recurrenceEnd) + "T235959Z";
  return r;
}

function eventToVEVENT(ev) {
  const lines = ["BEGIN:VEVENT"];
  lines.push("UID:" + (ev.id || Math.random().toString(36).slice(2)) + "@gabos");
  lines.push("DTSTAMP:" + icsDateTime(ev.date, "12:00") + "Z");
  if (ev.startTime) {
    lines.push("DTSTART:" + icsDateTime(ev.date, ev.startTime));
    if (ev.endTime) lines.push("DTEND:" + icsDateTime(ev.date, ev.endTime));
  } else {
    lines.push("DTSTART;VALUE=DATE:" + icsDate(ev.date));
    lines.push("DTEND;VALUE=DATE:" + icsDate(addDayStr(ev.date)));
  }
  const rrule = icsRRule(ev);
  if (rrule) lines.push(rrule);
  lines.push("SUMMARY:" + icsEscape(ev.title || "Sans titre"));
  if (ev.location) lines.push("LOCATION:" + icsEscape(ev.location));
  const desc = [ev.notes, ev.email && ("Email : " + ev.email), ev.phone && ("Tél : " + ev.phone)]
    .filter(Boolean).join("\n");
  if (desc) lines.push("DESCRIPTION:" + icsEscape(desc));
  lines.push("END:VEVENT");
  return lines.join("\r\n");
}

function buildICS(events) {
  return [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//GabOS//Calendrier//FR",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:GabOS",
    ...events.filter((e) => e && e.date).map(eventToVEVENT),
    "END:VCALENDAR",
  ].join("\r\n");
}

// ─── Fonction HTTP : /icsFeed?token=<token> ───────────────────────
exports.icsFeed = functions.https.onRequest(async (req, res) => {
  try {
    const token = String(req.query.token || "").trim();
    if (!token) {
      res.status(400).send("Paramètre token manquant.");
      return;
    }

    // Retrouver l'utilisateur dont le profil contient ce token
    const snap = await admin.firestore()
      .collection("users")
      .where("icsToken", "==", token)
      .limit(1)
      .get();

    if (snap.empty) {
      res.status(404).send("Token invalide.");
      return;
    }

    const docData = snap.docs[0].data() || {};
    // Les données GabOS sont stockées sous data["life_events"] (chaîne JSON)
    let events = [];
    try {
      const raw = docData.data && docData.data["life_events"];
      events = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(events)) events = [];
    } catch (e) {
      events = [];
    }

    res.set("Content-Type", "text/calendar; charset=utf-8");
    res.set("Content-Disposition", 'inline; filename="gabos.ics"');
    res.set("Cache-Control", "public, max-age=900"); // 15 min
    res.status(200).send(buildICS(events));
  } catch (err) {
    console.error(err);
    res.status(500).send("Erreur serveur.");
  }
});
