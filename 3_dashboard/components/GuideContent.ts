// Guide copy, English + Amharic. Both languages live side by side in this one
// file so a change to one is an obvious prompt to change the other; the guide is
// useless the moment the two versions describe different products.
//
// Every number comes from Props (config + live DB), never written into the text,
// so an admin changing a quota or a pay rate can't leave the guide lying.

export interface GuideVideoItem {
  id: number
  url: string
  title: string
  note: string
  lang: string
}

export interface GuideProps {
  /** Links shown per page in the dashboard list. */
  linksPerPage: number
  /** Absolute URL of the live site — the guide is shared off-site, so its
   *  "start working" link cannot be relative. */
  startUrl?: string
  /** Clips the admin uploaded, in the order they were arranged. Empty is the
   *  normal state — the guide reads perfectly well without them. */
  videos?: GuideVideoItem[]
  commentRate: number
  videoBirr: number
  promoBirr: number
  promoPerPlatform: number
  promoDownloads: number
  reminderClicks: number
  /** Birr per company email address a worker creates. */
  accountBirr: number
  /** The domain they must create it on. Blank while the task is closed. */
  accountDomain: string
  /** The password to set on the mailbox. Blank = not part of the instructions. */
  accountPassword: string
  /** Whether the task is being offered at all — a closed task is left out of
   *  the guide entirely rather than described and then not there. */
  accountOpen: boolean
}

export interface Section {
  heading: string
  intro?: string
  steps?: string[]
  rows?: { k: string; v: string }[]
  note?: string
}

export interface GuideCopy {
  title: string
  subtitle: string
  back: string
  rates: { label: string; value: string; hint: string }[]
  /** Shown instead of `back` to a visitor who is not signed in. */
  signIn: string
  /** The call to action that sends a reader to the site to begin. */
  startCta: string
  startHint: string
  /** Heading for the uploaded video walkthroughs. */
  videoHeading: string
  videoIntro: string
  footer: string
  sections: Section[]
}

export function en(p: GuideProps): GuideCopy {
  return {
    title: 'How it works',
    subtitle: 'Everything you need: the app, the dashboard, and how you get paid.',
    back: '← Links',
    signIn: 'Sign in to start →',
    startCta: 'Start working →',
    startHint: 'Sign in with Google, finish the short setup, and your first links are there.',
    rates: [
      { label: 'Per comment', value: `${p.commentRate} birr`, hint: 'on your reported count' },
      { label: 'Per video you make', value: `${p.videoBirr} birr`, hint: '30s–1min, once approved' },
      { label: 'Per repost link', value: `${p.promoBirr} birr`, hint: 'one per platform per day' },
      ...(p.accountOpen
        ? [{
            label: 'Per company email',
            value: `${p.accountBirr} birr`,
            hint: 'once we have checked it',
          }]
        : []),
      { label: 'Payday', value: 'Every Monday', hint: 'straight to your bank account' },
    ],
    videoHeading: 'Video walkthroughs',
    videoIntro:
      'Watch these if the steps above are easier to follow on screen. They open here — nothing to download.',
    footer: 'Questions? Message the admin from the dashboard and the reply appears there.',
    sections: [
      {
        heading: '1. Set up your account',
        intro: 'Do this once, on the website.',
        steps: [
          'Sign in with your Google account.',
          'Enter your full name and the bank account number you want to be paid into.',
          'Add your TikTok, YouTube and Instagram profile links. These are the accounts you will comment from, so they must be real accounts you control.',
          'Save. You land on the Links page, which is your dashboard.',
        ],
        note: 'Type your bank account number carefully. You are paid every Monday, and the money goes to exactly the account number you enter here — a wrong digit means a failed or misdirected payment.',
      },
      {
        heading: '2. Install the Comment Helper app',
        intro: 'The app is what makes commenting fast. You do the work in the app, not on the website.',
        steps: [
          'On the dashboard, find the Android app section and download the APK.',
          'Open the downloaded file, and allow installing from your browser if Android asks.',
          'Open the app and sign in with the same Google account you used on the website.',
          'Allow the "Display over other apps" permission. Without it the floating bubble cannot appear on top of TikTok.',
          'A small floating bubble now stays on screen over any app.',
        ],
        note: 'If the app says "Update the app first to get links", download the newest APK from the dashboard. Old versions stop receiving links.',
      },
      {
        heading: '3. The floating bubble',
        intro: 'This is the bubble you use all day. Drag it anywhere on screen.',
        rows: [
          { k: 'Next ▶', v: 'The main button. Copies a comment for you and opens the next video.' },
          { k: '🚫 Unrelated', v: 'Use it when the video has nothing to do with what we advertise. It flags the link and takes you straight to the next one. It does not count against you.' },
          { k: '☰ All ▾', v: 'Work on one platform only (TikTok, Instagram, and so on) or leave it on All.' },
          { k: '💬', v: 'Shows the comment that was copied, in case you need to see it again.' },
          { k: '⛶', v: 'Opens the full dashboard inside the app.' },
          { k: '… Details', v: 'Your totals, how many links are left, and any hourly countdown.' },
          { k: 'Counter', v: 'How many links you have opened out of the batch loaded on your phone.' },
          { k: '✕', v: 'Hides the bubble. Reopen it from the app.' },
        ],
      },
      {
        heading: '4. How to comment — the loop you repeat',
        intro: 'This is the part you repeat all session. It takes a few seconds per video once you are used to it.',
        steps: [
          'Tap Next ▶. The app copies a comment to your clipboard and opens the video.',
          'The video opens in TikTok, YouTube or Instagram. Watch a second or two so it counts as a real view.',
          'Open the comment box, long-press it and choose Paste. The comment is already on your clipboard — you never type it.',
          'Post the comment.',
          'Go back to the bubble and tap Next ▶ for the next video.',
        ],
        note: 'Never edit the comment and never post your own words. The comment you are given is the one that must go up, and never comment twice on the same video.',
      },
      {
        heading: '5. When a video is not related',
        intro: 'Some links are wrong: a random cooking video, a language you cannot comment in, or something unrelated to what we advertise.',
        steps: [
          'Tap 🚫 Unrelated while you are on that video.',
          'The link is flagged, it stops counting toward your quota, and you move to the next link automatically.',
          'You are never shown that link again.',
        ],
        note: 'Do not use Unrelated just to skip a video you do not feel like doing. It is for genuinely wrong links.',
      },
      {
        heading: '6. Report your work and get paid',
        intro: 'Your commenting is only counted once you report it. Do this at the end of every session.',
        steps: [
          'Tap Finish in the app, or open the Finish page on the website.',
          'For each platform, enter how many videos you commented on.',
          'Upload screenshots of your comment history showing the comments you posted.',
          'Submit. Your pending pay updates on the dashboard right away.',
          'Payment is sent every Monday, straight to the bank account number you entered when you set up your account. Whatever you report during the week is paid on the following Monday, and what you see under pending pay is what is owed to you so far.',
        ],
        note: 'Report honestly. Your number is checked against the links you actually opened and against your screenshots. Inflated numbers are removed and can get your account blocked.',
      },
      {
        heading: '7. The other ways to earn',
        intro: 'All optional, and all on the dashboard.',
        rows: [
          {
            k: '🎥 Video task',
            v: `Make your own 30-second to 1-minute video advertising one of our products, upload it, and earn ${p.videoBirr} birr once the admin approves it.`,
          },
          {
            k: '📢 Repost & earn',
            v: `Create a dedicated account on each platform, download a ready-made video and caption from the dashboard, post it, then paste the link back. ${p.promoBirr} birr per link. You may download ${p.promoDownloads} video per day and post ${p.promoPerPlatform} per platform per day.`,
          },
          ...(p.accountOpen
            ? [{
                k: '✉️ Email task',
                v:
                  `Create an email address on our own domain — it must end in ` +
                  `@${p.accountDomain} — and send us the address on the Email task page. ` +
                  (p.accountPassword
                    ? `Set the password to exactly ${p.accountPassword}, capitals and symbols ` +
                      `included — an address we cannot sign in to is rejected and not paid. `
                    : '') +
                  `${p.accountBirr} birr for each one. The pay shows as UNAPPROVED until we ` +
                  `open the mailbox and confirm it works; then it joins your approved pay. ` +
                  `An address someone has already sent cannot be sent again, and a rejected ` +
                  `one tells you why.`,
              }]
            : []),
        ],
      },
      {
        heading: '8. The website (dashboard)',
        intro: 'The website is for setup, reporting and payment. Day-to-day commenting happens in the app.',
        rows: [
          { k: 'Links', v: 'Your remaining links, grouped, plus your totals for today.' },
          { k: 'Pages', v: `Links come a page at a time, best group first — ${p.linksPerPage} on a page, which is about an hour's work. Use Next at the bottom for the following page.` },
          { k: 'Comments', v: 'The comment pool. Tap any comment to copy it manually if you need to.' },
          { k: 'Video task', v: 'Upload your own video and see whether it was approved.' },
          { k: 'Repost & earn', v: 'Download promo videos and captions, and submit your reposted links.' },
          ...(p.accountOpen
            ? [{
                k: 'Email task',
                v: 'Send us the addresses you created, and see which have been checked.',
              }]
            : []),
          { k: 'Finish', v: 'Report your counts and screenshots.' },
          { k: 'Messages', v: 'Messages from the admin appear at the top of the dashboard, and you can reply there.' },
        ],
      },
      {
        heading: '9. Rules that protect your pay',
        rows: [
          { k: 'Real accounts', v: 'Comment from real accounts with a normal history. Brand new empty accounts get their comments hidden by the platform, and hidden comments do not count.' },
          { k: 'One per video', v: 'Never comment twice on the same video.' },
          { k: 'Respect the limits', v: 'The hourly limits exist so your accounts are not flagged as spam. Wait for the countdown instead of switching accounts.' },
          { k: 'Keep screenshots', v: 'Screenshots are your proof. Without them a report can be rejected.' },
          { k: 'Do not edit', v: 'Post the comment exactly as it was copied.' },
        ],
        note: `On your first ${p.reminderClicks} links the app asks you to confirm, as a reminder that opening a link removes it from your list.`,
      },
    ],
  }
}

export function am(p: GuideProps): GuideCopy {
  return {
    title: 'እንዴት እንደሚሠራ',
    subtitle: 'የሚያስፈልግዎት ሁሉ፦ አፑ፣ ዳሽቦርዱ እና ክፍያ የሚያገኙበት መንገድ።',
    back: '← ወደ ሊንኮች',
    signIn: 'ለመጀመር ይግቡ →',
    startCta: 'ሥራ ይጀምሩ →',
    startHint: 'በGoogle ይግቡ፣ አጭሩን ዝግጅት ይጨርሱ፤ የመጀመሪያዎቹ ሊንኮችዎ እዚያው ይጠብቁዎታል።',
    rates: [
      { label: 'ለአንድ አስተያየት', value: `${p.commentRate} ብር`, hint: 'ሪፖርት ባደረጉት ብዛት መሠረት' },
      { label: 'ለሠሩት አንድ ቪዲዮ', value: `${p.videoBirr} ብር`, hint: '30 ሰከንድ–1 ደቂቃ፣ ከጸደቀ በኋላ' },
      { label: 'ለአንድ ሪፖስት ሊንክ', value: `${p.promoBirr} ብር`, hint: 'በቀን በአንድ መድረክ አንድ' },
      ...(p.accountOpen
        ? [{
            label: 'ለአንድ የኩባንያ ኢሜይል',
            value: `${p.accountBirr} ብር`,
            hint: 'ካረጋገጥነው በኋላ',
          }]
        : []),
      { label: 'የክፍያ ቀን', value: 'በየሰኞው', hint: 'በቀጥታ ወደ ባንክ ሒሳብዎ' },
    ],
    videoHeading: 'የቪዲዮ ማብራሪያዎች',
    videoIntro:
      'ከላይ ያሉት ደረጃዎች በምስል ማየት ከቀለለዎት እነዚህን ይመልከቱ። እዚሁ ላይ ይከፈታሉ፤ ማውረድ አያስፈልግም።',
    footer: 'ጥያቄ አለዎት? ከዳሽቦርዱ ላይ ለአስተዳዳሪው መልእክት ይላኩ፤ መልሱም እዚያው ይታያል።',
    sections: [
      {
        heading: '1. አካውንትዎን ያዘጋጁ',
        intro: 'ይህን አንድ ጊዜ ብቻ በድረ-ገጹ ላይ ያድርጉ።',
        steps: [
          'በGoogle አካውንትዎ ይግቡ።',
          'ሙሉ ስምዎን እና ክፍያ እንዲላክልዎ የሚፈልጉትን የባንክ ሒሳብ ቁጥር ያስገቡ።',
          'የTikTok፣ የYouTube እና የInstagram አካውንት ሊንኮችዎን ያስገቡ። አስተያየት የሚሰጡት ከእነዚህ አካውንቶች ስለሆነ፣ በእርስዎ ቁጥጥር ሥር ያሉ እውነተኛ አካውንቶች መሆን አለባቸው።',
          'ያስቀምጡ። ወደ ሊንኮች ገጽ ይደርሳሉ፤ ይህም ዳሽቦርድዎ ነው።',
        ],
        note: 'የባንክ ሒሳብ ቁጥርዎን በጥንቃቄ ይጻፉ። ክፍያ የሚፈጸመው በየሰኞው ሲሆን፣ ገንዘቡ የሚላከው እዚህ ላይ በጻፉት የሒሳብ ቁጥር በትክክል ነው፤ አንድ የተሳሳተ ቁጥር ክፍያው እንዲቋረጥ ወይም ወደ ሌላ ሰው እንዲሄድ ያደርጋል።',
      },
      {
        heading: '2. የComment Helper አፑን ይጫኑ',
        intro: 'አስተያየት መስጠትን ፈጣን የሚያደርገው አፑ ነው። ሥራውን የሚሠሩት በአፑ ላይ እንጂ በድረ-ገጹ ላይ አይደለም።',
        steps: [
          'በዳሽቦርዱ ላይ የAndroid አፕ ክፍሉን አግኝተው APK ፋይሉን ያውርዱ።',
          'ያወረዱትን ፋይል ይክፈቱ፤ Android ከጠየቀ ከbrowserዎ መጫንን ይፍቀዱ።',
          'አፑን ከፍተው በድረ-ገጹ ላይ በተጠቀሙበት ተመሳሳይ የGoogle አካውንት ይግቡ።',
          '"Display over other apps" (በሌሎች አፖች ላይ ማሳየት) የሚለውን ፈቃድ ይስጡ። ይህ ከሌለ ተንሳፋፊው ቁልፍ ከTikTok በላይ ሊታይ አይችልም።',
          'አሁን ትንሽ ተንሳፋፊ ቁልፍ በማንኛውም አፕ ላይ በስክሪኑ ላይ ይቆያል።',
        ],
        note: 'አፑ "Update the app first to get links" ካለ፣ ከዳሽቦርዱ አዲሱን APK ያውርዱ። አሮጌ ስሪቶች ሊንክ መቀበል ያቆማሉ።',
      },
      {
        heading: '3. ተንሳፋፊው ቁልፍ (bubble)',
        intro: 'ቀኑን ሙሉ የሚጠቀሙበት ይህ ነው። በስክሪኑ ላይ ወደፈለጉት ቦታ መጎተት ይችላሉ።',
        rows: [
          { k: 'Next ▶', v: 'ዋናው ቁልፍ። አስተያየቱን ኮፒ አድርጎ ቀጣዩን ቪዲዮ ይከፍታል።' },
          { k: '🚫 Unrelated', v: 'ቪዲዮው እኛ ከምናስተዋውቀው ጋር ምንም ግንኙነት ከሌለው ይጠቀሙበት። ሊንኩን ምልክት አድርጎ በቀጥታ ወደ ቀጣዩ ያሸጋግርዎታል። በእርስዎ ላይ አይቆጠርም።' },
          { k: '☰ All ▾', v: 'በአንድ መድረክ ብቻ ለመሥራት (TikTok ብቻ፣ Instagram ብቻ ወዘተ) ወይም All ላይ ይተውት።' },
          { k: '💬', v: 'ኮፒ የተደረገውን አስተያየት እንደገና ማየት ከፈለጉ ያሳያል።' },
          { k: '⛶', v: 'ሙሉውን ዳሽቦርድ በአፑ ውስጥ ይከፍታል።' },
          { k: '… Details', v: 'ጠቅላላ ውጤትዎን፣ የቀሩትን ሊንኮች ብዛት እና የሰዓት ቆጠራን ያሳያል።' },
          { k: 'ቆጣሪ', v: 'በስልክዎ ላይ ከተጫኑት ሊንኮች ውስጥ ስንቱን እንደከፈቱ ያሳያል።' },
          { k: '✕', v: 'ቁልፉን ይሰውራል። ከአፑ እንደገና ይክፈቱት።' },
        ],
      },
      {
        heading: '4. አስተያየት እንዴት እንደሚሰጡ — ተደጋጋሚው ሂደት',
        intro: 'ይህ በሥራ ጊዜዎ ሁሉ የሚደጋገም ነው። ከለመዱት በኋላ ለአንድ ቪዲዮ ጥቂት ሰከንዶች ብቻ ይወስዳል።',
        steps: [
          'Next ▶ ን ይንኩ። አፑ አስተያየቱን ኮፒ አድርጎ ቪዲዮውን ይከፍታል።',
          'ቪዲዮው በTikTok፣ YouTube ወይም Instagram ይከፈታል። እንደ እውነተኛ እይታ እንዲቆጠር ለአንድ ወይም ለሁለት ሰከንድ ይመልከቱ።',
          'የአስተያየት ሳጥኑን ከፍተው ተጭነው ይያዙና Paste (ለጥፍ) ይምረጡ። አስተያየቱ አስቀድሞ ኮፒ ተደርጓል፤ በጭራሽ አይተይቡም።',
          'አስተያየቱን ይለጥፉ።',
          'ወደ ተንሳፋፊው ቁልፍ ተመልሰው ለቀጣዩ ቪዲዮ Next ▶ ን ይንኩ።',
        ],
        note: 'አስተያየቱን በጭራሽ አያስተካክሉ፤ የራስዎን ቃላትም አይለጥፉ። የተሰጠዎት አስተያየት እንዳለ መለጠፍ አለበት። እንዲሁም በአንድ ቪዲዮ ላይ ሁለት ጊዜ አስተያየት አይስጡ።',
      },
      {
        heading: '5. ቪዲዮው ተዛማጅ ካልሆነ',
        intro: 'አንዳንድ ሊንኮች ትክክል አይደሉም፤ ለምሳሌ የምግብ ማብሰያ ቪዲዮ፣ አስተያየት መስጠት በማይችሉበት ቋንቋ የተሠራ፣ ወይም እኛ ከምናስተዋውቀው ጋር ግንኙነት የሌለው።',
        steps: [
          'በዚያ ቪዲዮ ላይ እያሉ 🚫 Unrelated ን ይንኩ።',
          'ሊንኩ ምልክት ይደረግበታል፣ በሰዓት ገደብዎ ላይ መቆጠሩ ይቆማል፣ እና በራስ-ሰር ወደ ቀጣዩ ሊንክ ይሄዳሉ።',
          'ያ ሊንክ ዳግመኛ አይታይዎትም።',
        ],
        note: 'መሥራት ስላልፈለጉ ብቻ ቪዲዮ ለመዝለል Unrelated ን አይጠቀሙ። ይህ በእውነት ለተሳሳቱ ሊንኮች ብቻ ነው።',
      },
      {
        heading: '6. ሥራዎን ሪፖርት አድርገው ክፍያ ያግኙ',
        intro: 'የሰጡት አስተያየት የሚቆጠረው ሪፖርት ካደረጉ በኋላ ብቻ ነው። ይህን በእያንዳንዱ የሥራ ጊዜ መጨረሻ ላይ ያድርጉ።',
        steps: [
          'በአፑ ላይ Finish ን ይንኩ፣ ወይም በድረ-ገጹ ላይ የFinish ገጹን ይክፈቱ።',
          'ለእያንዳንዱ መድረክ በስንት ቪዲዮዎች ላይ አስተያየት እንደሰጡ ያስገቡ።',
          'የለጠፏቸውን አስተያየቶች የሚያሳዩ የአስተያየት ታሪክዎን ስክሪንሾቶች ይላኩ።',
          'ይላኩ። በዳሽቦርዱ ላይ ያለው ገና ያልተከፈለ ክፍያዎ ወዲያውኑ ይዘመናል።',
          'ክፍያ በየሰኞው ይላካል፤ አካውንትዎን ሲያዘጋጁ ባስገቡት የባንክ ሒሳብ ቁጥር በቀጥታ ይከፈላል። በሳምንቱ ውስጥ ሪፖርት ያደረጉት በሚቀጥለው ሰኞ ይከፈላል፤ በዳሽቦርዱ ላይ በ"ገና ያልተከፈለ ክፍያ" ሥር የሚያዩት እስካሁን የሚገባዎትን ገንዘብ ያሳያል።',
        ],
        note: 'በሐቀኝነት ሪፖርት ያድርጉ። ያስገቡት ቁጥር በእውነት ከከፈቷቸው ሊንኮች እና ከስክሪንሾቶችዎ ጋር ይመሳከራል። የተጋነኑ ቁጥሮች ይሰረዛሉ፤ አካውንትዎም ሊታገድ ይችላል።',
      },
      {
        heading: '7. ሌሎቹ የገቢ መንገዶች',
        intro: 'ሁሉም በፈቃደኝነት ላይ የተመሠረቱ ሲሆኑ በዳሽቦርዱ ላይ ይገኛሉ።',
        rows: [
          {
            k: '🎥 የቪዲዮ ሥራ',
            v: `ከምርቶቻችን አንዱን የሚያስተዋውቅ ከ30 ሰከንድ እስከ 1 ደቂቃ የሚደርስ የራስዎን ቪዲዮ ሠርተው ይላኩ፤ አስተዳዳሪው ካጸደቀው ${p.videoBirr} ብር ያገኛሉ።`,
          },
          {
            k: '📢 ሪፖስት አድርገው ያግኙ',
            v: `በእያንዳንዱ መድረክ ላይ የተለየ አካውንት ይክፈቱ፣ ከዳሽቦርዱ ዝግጁ የሆነ ቪዲዮና ጽሑፍ አውርደው ይለጥፉ፣ ከዚያም ሊንኩን መልሰው ይለጥፉ። ለአንድ ሊንክ ${p.promoBirr} ብር። በቀን ${p.promoDownloads} ቪዲዮ ማውረድ እና በአንድ መድረክ በቀን ${p.promoPerPlatform} መለጠፍ ይችላሉ።`,
          },
          ...(p.accountOpen
            ? [{
                k: '✉️ የኢሜይል ሥራ',
                v:
                  `በራሳችን ዶሜይን ላይ የኢሜይል አድራሻ ይክፈቱ — በ@${p.accountDomain} ማለቅ አለበት — ` +
                  `ከዚያም አድራሻውን በ“የኢሜይል ሥራ” ገጽ ላይ ይላኩልን። ለእያንዳንዱ ${p.accountBirr} ብር። ` +
                  (p.accountPassword
                    ? `የይለፍ ቃሉን በትክክል ${p.accountPassword} ያድርጉት፤ ትላልቅ ፊደላትንና ምልክቶችን ጨምሮ — ` +
                      `ልንገባበት የማንችለው አድራሻ ውድቅ ይደረጋል፤ ክፍያም አይከፈልም። `
                    : '') +
                  `ኢሜይሉን ከፍተን እስክናረጋግጥ ድረስ ክፍያው “ያልጸደቀ” ሆኖ ይታያል፤ ካረጋገጥን በኋላ ወደ ጸደቀው ` +
                  `ክፍያዎ ይጨመራል። ሌላ ሰው የላከውን አድራሻ እንደገና መላክ አይቻልም፤ ውድቅ የተደረገም ከሆነ ምክንያቱ ይነገርዎታል።`,
              }]
            : []),
        ],
      },
      {
        heading: '8. ድረ-ገጹ (ዳሽቦርድ)',
        intro: 'ድረ-ገጹ ለዝግጅት፣ ለሪፖርት እና ለክፍያ ነው። የዕለት ተዕለት አስተያየት መስጠት የሚከናወነው በአፑ ላይ ነው።',
        rows: [
          { k: 'ሊንኮች', v: 'የቀሩት ሊንኮችዎ በቡድን ተከፋፍለው፣ እንዲሁም የዛሬው ጠቅላላ ውጤትዎ።' },
          { k: 'ገጾች', v: `ሊንኮች በገጽ በገጽ ይቀርባሉ፤ ምርጡ ቡድን መጀመሪያ። በአንድ ገጽ ${p.linksPerPage} ሊንኮች ሲሆኑ ይህም የአንድ ሰዓት ያህል ሥራ ነው። ቀጣዩን ገጽ ለማየት ከታች ያለውን Next ይጠቀሙ።` },
          { k: 'አስተያየቶች', v: 'የአስተያየት ስብስቡ። ካስፈለገዎት ማንኛውንም አስተያየት ነክተው በእጅ ኮፒ ማድረግ ይችላሉ።' },
          { k: 'የቪዲዮ ሥራ', v: 'የራስዎን ቪዲዮ ይላኩ እና መጽደቁን ይከታተሉ።' },
          { k: 'ሪፖስት አድርገው ያግኙ', v: 'የማስተዋወቂያ ቪዲዮዎችንና ጽሑፎችን ያውርዱ፣ የለጠፏቸውንም ሊንኮች ይላኩ።' },
          { k: 'Finish', v: 'ብዛቱንና ስክሪንሾቶችን ሪፖርት ያድርጉ።' },
          { k: 'መልእክቶች', v: 'ከአስተዳዳሪው የሚላኩ መልእክቶች በዳሽቦርዱ ላይኛው ክፍል ይታያሉ፤ እዚያው መመለስ ይችላሉ።' },
        ],
      },
      {
        heading: '9. ክፍያዎን የሚጠብቁ ደንቦች',
        rows: [
          { k: 'እውነተኛ አካውንቶች', v: 'መደበኛ ታሪክ ካላቸው እውነተኛ አካውንቶች አስተያየት ይስጡ። አዲስ እና ባዶ አካውንቶች የሚሰጡት አስተያየት በመድረኩ ይሰወራል፤ የተሰወረ አስተያየት ደግሞ አይቆጠርም።' },
          { k: 'በአንድ ቪዲዮ አንድ', v: 'በአንድ ቪዲዮ ላይ ሁለት ጊዜ አስተያየት በጭራሽ አይስጡ።' },
          { k: 'ገደቦቹን ያክብሩ', v: 'የሰዓት ገደቦቹ የተቀመጡት አካውንቶችዎ እንደ ስፓም እንዳይቆጠሩ ነው። አካውንት ከመቀያየር ይልቅ ቆጠራው እስኪያልቅ ይጠብቁ።' },
          { k: 'ስክሪንሾቶችን ይያዙ', v: 'ስክሪንሾቶች ማስረጃዎ ናቸው። ያለ እነሱ ሪፖርትዎ ውድቅ ሊሆን ይችላል።' },
          { k: 'አያስተካክሉ', v: 'አስተያየቱን ኮፒ እንደተደረገው በትክክል ይለጥፉ።' },
        ],
        note: `በመጀመሪያዎቹ ${p.reminderClicks} ሊንኮች ላይ አፑ እንዲያረጋግጡ ይጠይቅዎታል፤ ይህም ሊንክ መክፈት ከዝርዝርዎ እንደሚያስወግደው ለማስታወስ ነው።`,
      },
    ],
  }
}
