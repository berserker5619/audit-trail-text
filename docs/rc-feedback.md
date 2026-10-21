# 1.0.0-rc.1 feedback: real-record round

Two realistic schemas, a CRM contact and a garment-style PLM style, with 26 edit scenarios between them: [test/rc/scenarios.ts](../test/rc/scenarios.ts). Every sentence was read by hand. They are checked in as [test/rc/sentences.json](../test/rc/sentences.json), so any change to the wording shows up in review.

Options: locale `en-IN`, time zone `Asia/Kolkata`.

## Fixed in rc.1

| # | Found | Was | Now |
| --- | --- | --- | --- |
| RC1-1 | An item named by its key showed the stored code, even when the key field has `oneOf` labels | Addresses › home: PIN code changed… / Address "work" added to Addresses | Addresses › Home: PIN code changed… / Address "Work" added to Addresses |
| RC1-2 | A custom template that didn't mention `{parents}` lost a nested field's context, and a template couldn't add it only when there are parents (found while writing the README) | `{field}: {before} → {after}` gave "Quantity: 2 → 3" | Custom templates get the parents first too, unless they place `{parents}` themselves: "Orders › Blue kurta: Quantity: 2 → 3" |
| RC1-3 | `translateLabel` received item names inside the label path, so a dictionary lookup could translate a product called "Rose" | `translateLabel(label, schemaPath)` | `translateLabel(label, { kind, schemaPath })`; item names never go through it. Changes record which labels are item names in `display.itemLabels` |

RC1-1 changes `item.label` in stored changes for lists keyed by a coded field. Changes stored before rc.1 keep the code.

## Reviewed for 1.0: none produce a wrong sentence

Each open item was checked against the question "is the sentence wrong, or only worded in a way we might prefer?". None is wrong, so none changes the code for 1.0. Three are now covered in the README.

| # | Scenario | Sentence | Why it stays |
| --- | --- | --- | --- |
| RC1-4 | CRM: field from an integration | Zoho Id changed from "Z-1" to "Z-2" | Wording. Title Case can't know which words are acronyms, and guessing would rename fields people already see. The README shows `"/zohoId": "Zoho ID"` in the labels file |
| RC1-5 | CRM: qualified and reassigned | Source changed from walk-in to referral | Wording. `enum` shows the stored code, as the spec says. Codes people read should use `oneOf` with titles |
| RC1-6 | CRM: company added | Company added | Scope. Correct per spec; `expandObjects: true` lists the fields. Naming the object would need a new keyword |
| RC1-7 | PLM: size added, quantity changed | Colourways › Navy › Size breakdown › M, Regular: Quantity changed from 300 to 1,250 | Wording. Correct and unambiguous. Changing the fallback joiner would change stored `item.label` values. The README shows `x-label` / `#label` to name items |
| RC1-8 | PLM: BOM supplier switched | BOM line "Button (YKK)" removed… / BOM line "Button (Shingora)" added… | Correct for the key the schema gives. The README now says to key items by what never changes for them |
| RC1-9 | CRM: notes reordered and one edited | Notes › Follow-up call: Body changed… / Notes reordered | Correct. Naming the moved item would be a new option, not a fix |
| RC1-10 | CRM: contact created / deleted | Contact created | Scope. Correct per spec. A record name would need a root-level label template; apps usually show the record next to the entry |

## Read and fine as they are

- Status labels: "Status changed from Lead to Qualified lead", "Stage changed from Proto sample to Approved for production".
- Sensitive fields: "PAN changed", "Password set", "Target FOB (USD) changed". No values anywhere in the stored changes.
- Dates: "Date of birth set to 14 Mar 1988"; "Last contacted changed from 1 Oct 2026, 3:00 pm to 21 Oct 2026, 7:35 pm" in Asia/Kolkata; "Launch date cleared (was 15 Feb 2027)".
- Numbers and booleans: "Credit limit changed from 50,000 to 1,25,000", "WhatsApp opt-in changed from No to Yes", "Consumption changed from 2.4 to 2.55".
- Lists: "Colourway "Mustard" added to Colourways", "Colourways reordered", "Colourways › Navy: Size breakdown reordered", "Wholesale removed from Tags" / "VIP added to Tags".
- An ignored field alone (`updatedAt`) gives no changes.
