=== Site Rep — Source-Backed Website Chat ===
Contributors: siterep
Tags: chatbot, ai chat, customer support, lead capture, live chat
Requires at least: 5.5
Tested up to: 6.7
Requires PHP: 7.2
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Add your Site Rep widget to WordPress. It answers visitors from your approved pages, cites the source, refuses when proof is missing, and captures leads.

== Description ==

Site Rep is a website chat widget that answers visitor questions using only your own approved pages — and refuses to guess when it can't prove the answer. Every answer shows its source, and any question your pages don't cover becomes a lead and a follow-up item instead of a made-up reply.

This plugin adds the Site Rep widget to your WordPress site. There is no code to paste: enter your Workspace ID and widget key from your Site Rep dashboard, and the widget appears on every page.

**Why Site Rep is different**

* Answers only from your approved content, with the source shown on every answer.
* Refuses when the proof isn't there — no invented prices, policies, or promises.
* Turns missing answers into captured leads and workspace follow-up.
* Flat monthly pricing and a free trial with no credit card.

You need a Site Rep account to use this plugin. Start free at https://siterep.net/ — the free trial includes 50 source-backed answers with no card.

== Installation ==

1. Install and activate the plugin.
2. Go to **Settings → Site Rep**.
3. Paste your **Workspace ID** and **widget key** from your Site Rep dashboard.
4. Save. The widget is now live on your site.

Your public widget key is checked against approved domains for browser widget requests. It is designed to live in public page markup; it is not a password or API secret. The plugin stores no passwords or tokens.

== Frequently Asked Questions ==

= Do I need a Site Rep account? =

Yes. Create one and train your bot at https://siterep.net/, then copy your Workspace ID and widget key into the plugin settings.

= Is the widget key a secret? =

No. Site Rep checks the public widget key against approved domains for browser widget requests. It is designed to live in public page markup; it is not a password or API secret.

= Where does the widget appear? =

On the front end of every page, in the bottom corner, after the rest of the page loads.

= How do I remove it? =

Clear the Workspace ID or widget key in Settings → Site Rep, or deactivate the plugin.

== Privacy ==

This plugin only injects the Site Rep widget script using the Workspace ID and widget key you enter. Visitor questions and any leads are handled by Site Rep under its own privacy terms at https://siterep.net/privacy. The plugin itself stores only your Workspace ID, widget key, and optional accent colour in your WordPress options table.

== Changelog ==

= 1.0.0 =
* Initial release: settings page and footer widget injection with domain-locked widget key.
