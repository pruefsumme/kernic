#set page(paper: "a4", margin: (x: 2.5cm, top: 2.5cm, bottom: 2.5cm))
#set text(size: 11pt, lang: "en")
#set par(leading: 0.7em, spacing: 1.1em)

// Sender
#align(right)[
  Your Name \
  Street 1 \
  12345 City \
  you\@example.org
]

#v(1.5cm)

// Recipient
Recipient Name \
Organisation \
Street 2 \
54321 City

#v(1cm)

#align(right)[#datetime.today().display("[day] [month repr:long] [year]")]

#v(0.5cm)

*Subject of the letter*

Dear Recipient Name,

open with the reason you are writing. Keep the first paragraph to the point so
the reader knows what the letter is about.

Use the following paragraphs for the details: what happened, what you are
asking for, and by when.

Close with the next step you expect or offer.

Kind regards,

#v(1.2cm)

Your Name
