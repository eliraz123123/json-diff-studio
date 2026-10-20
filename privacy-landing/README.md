# Landing page: תיק פרטיות

A one-page Hebrew (RTL) landing page that tests demand for a work tool for Israeli privacy consultants and DPOs before any product is built. It explains the idea, offers a paid pilot, and collects sign-ups.

No dependencies. `page.html` is the template, `config.json` holds your details, and `build.mjs` produces `dist/index.html`.

## Before publishing (about 30 minutes)

1. **Collect sign-ups.** Create a free form at [Formspree](https://formspree.io) (50 submissions a month free) and copy its endpoint, for example `https://formspree.io/f/abcdwxyz`. Submissions arrive by email and in the Formspree dashboard. Any service that accepts a form POST and answers with JSON works (Basin, Getform); change `FORM_PROVIDER` to match, because the privacy notice names it.
2. **Fill in `config.json`:**
   - `FOUNDER_NAME`: your name, as people will see it.
   - `FOUNDER_BLURB`: one sentence about you, for example "מפתח תוכנה עם 8 שנות ניסיון בבניית מערכות לעסקים."
   - `CONTACT_EMAIL`: an address you read. It appears in the privacy notice, where people can ask to see or delete their details.
   - `SIGNUP_ENDPOINT`: the endpoint from step 1.
   - `PRODUCT_NAME`: "תיק פרטיות" is a working name. Check it is free before you invest in it.
3. **Build:** `node privacy-landing/build.mjs`. The build stops if anything is missing, so placeholders never reach the live page.
4. **Check the claims are still true for you:** a 6-week first version, a ₪500/month pilot for 3 months, a full refund, and encrypted storage. Change any you will not stand behind.

## Publish (free)

- **Netlify Drop:** drag the `privacy-landing/dist` folder onto <https://app.netlify.com/drop>. Live in a minute.
- **Vercel:** import the repo, set the root directory to `privacy-landing`, the build command to `node build.mjs`, and the output directory to `dist`.
- Connect a domain later; a `.co.il` costs about ₪60–100 a year.

## Measuring

The page has no analytics or cookies on purpose: it sells privacy, and a cookie banner would undercut that. Netlify and Vercel both offer cookie-free visit counts. The numbers that matter are sign-ups and how many of them agree to a call and to the paid pilot; track those in a sheet next to your interview notes.

## Notes

- Formspree is a US service, which means sign-up details are stored outside Israel. That is fine for business contact details, and the privacy notice names the provider.
- The client file in the hero is labelled as an example. Keep it that way until real screens exist.
