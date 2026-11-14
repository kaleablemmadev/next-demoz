# Business Study: Next Tutor Bot

### What is the problem?
1. A tutoring agency needs to repost an offer manually. That is an unneccessary effort wasted on remembering and finding open offers, rather than completely focus of bringing offers.
2. When a tutoring business scales and grows, they post many offers per day, which is harder and harder to search from for a tutor. Also harder to handle for an agency.
3. A tutor searches for some offers and then gives up since no offer is found for now, but when a matching offer comes, they lose it, which makes the tutor frustrated.
4. The main value a tutoring business brings is finding offers for the tutors and finding a tutor quickly for parents. Only tutors who know that agency can apply for it, which is not the best choice since many agencies exist in the telegram search bar.

### What Next Tutor is?
- Next Tutor is a telegram bot built for simplifying the tutor finding mechanism in tutoring agencies.

#### Features
1. Notification of matching offers to tutors within a minute of the offer happening.
2. Weekly (Monday morning) notifications showing open matching offers
3. Get offers by specific search by location, salary, grades, and subjects
4. Reposting the open offer in the channel after a specific time (default: 3 days) until the agency chooses to close or stop reposting it

### How Next Tutor works?
1. An agency posts the offer in the bot (they can add any text they want before and after the description of the offer)
2. The bot automatically posts the offer in the channel or in the gorup or both
3. It automatically sends the offer to any one who matches the details within 60 seconds
4. When a tutor enters the bot, it asks for preferred location, grade, subject and gender; and with the tutor's request, it shows all the offers matching the preferences immediately.
5. On Monday morning, the bot sends all the open offers until that time.
6. After a specific time (3 days), the app automatically reposts the open ones.
7. A tutor can search for offers using location, subject, salary, etc... preferrences and it will automatically load.