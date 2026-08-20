Currently, in the output website, on the review section there is in the title "5.0 out of 5 stars Superbe cadeau" but
I don't think the rating should be included in the title, because we already have a star rating anyway.  
For this perticular comment for example it should just be "Superbe cadeau".

---

In the suggestion section of the output website there should be an expandable section that disclose how thoses sugestion have been generated. I mean by that, showing the model that has been used and the exact prompt.

---

Currently the prompt here src/prompts/product-optimization.ts we have:

> -   The suggested title must contain at most ${AMAZON_TITLE_CHARACTER_LIMIT} Unicode characters including spaces, reflecting Amazon's general title-policy limit for most categories.

with AMAZON_TITLE_CHARACTER_LIMIT being 200.
But I don't hink we mention the official recomended lengh for a title. Figure out what is the official guidline and include it in the prompt. Not nessesarely as a hard limit that must at all cost be respected but as a strong insentive to respect the character budjet for the title.

---

For the "Regenerate suggestion with additional feedback" I would like that the user has clear feedback that the model is working, maybe, if available, show the reasoning output.

---

When running the build command I would like to have a better feedback than just "Requesting DeepSeek suggestions..." and "Requesting DeepSeek English translations...". I would like to see for how much time it has been thinking and when it's done the total time. But
not on a new line each time, the console line should be updated like "Requesting DeepSeek suggestions... 1 minute 25 seconds.
