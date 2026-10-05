// Layout for the report. Edit this file to change how every chapter looks.

#let report(title: "", subtitle: none, author: "", date: none, body) = {
  set document(title: title, author: author)
  set text(size: 11pt, lang: "en")
  set par(justify: true, leading: 0.7em)
  set heading(numbering: "1.1")

  // Title page
  page(margin: 3cm)[
    #v(1fr)
    #text(size: 26pt, weight: "bold")[#title]
    #if subtitle != none {
      v(0.6em)
      text(size: 13pt, fill: luma(80))[#subtitle]
    }
    #v(2em)
    #author
    #if date != none [
      \ #date.display("[day] [month repr:long] [year]")
    ]
    #v(2fr)
  ]

  set page(
    paper: "a4",
    margin: (x: 2.5cm, y: 3cm),
    numbering: "1",
    header: context {
      if counter(page).get().first() > 1 {
        text(size: 9pt, fill: luma(110))[#title]
      }
    },
  )
  counter(page).update(1)

  outline(depth: 2)
  pagebreak()

  // Start each chapter on a new page.
  show heading.where(level: 1): it => {
    pagebreak(weak: true)
    v(1em)
    it
    v(0.5em)
  }

  body
}
