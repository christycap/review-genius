I would like to have a mode, for speeding up the developement, where I can disable thinking.
Look in the .env.example and .env file, I have added an env DISABLE_THINKINK=. When it's true DeepSeek should never
be run in thinking mode, even for suggestion of copy.

---

Currently, in the output website, on the review section there is in the title "5.0 out of 5 stars Superbe cadeau" but
I don't think the rating should be included in the title, because we already have a star rating anyway.  
For this perticular comment for example it should just be "Superbe cadeau".

---

In the suggestion section of the output website there should be an expandable section that discose how thoses sugestion have been generated. I mean by that, showing the model that has been used and the exact prompt.

---

Currently the prompt here src/prompts/product-optimization.ts is too lax about the character lenght requirement.
