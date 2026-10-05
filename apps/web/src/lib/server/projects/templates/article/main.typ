#set document(title: "Article title", author: "Your Name")
#set page(paper: "a4", margin: (x: 2.5cm, y: 3cm), numbering: "1")
#set text(size: 11pt, lang: "en")
#set par(justify: true, leading: 0.7em)
#set heading(numbering: "1.1")
#set math.equation(numbering: "(1)")
#show heading: set block(above: 1.6em, below: 0.8em)

#align(center)[
  #text(size: 18pt, weight: "bold")[Article title]

  #v(0.4em)
  Your Name \
  #text(size: 9.5pt, fill: luma(90))[Affiliation · #datetime.today().display("[month repr:long] [year]")]
]

#v(1em)

#block(inset: (x: 2em))[
  *Abstract.* Summarize the question, the approach and the main result in a few
  sentences. Readers decide here whether to continue.
]

= Introduction

State the problem and why it matters. Cite prior work where it helps the reader
place yours, for example @knuth1984.

= Method

Describe what you did in enough detail that someone else could repeat it.

$ E = m c^2 $ <eq:energy>

@eq:energy can be referenced like any other labelled element.

= Results

#figure(
  table(
    columns: 3,
    align: (left, right, right),
    stroke: none,
    table.hline(),
    table.header[Condition][Samples][Mean],
    table.hline(stroke: 0.5pt),
    [Baseline], [120], [0.42],
    [Treatment], [118], [0.57],
    table.hline(),
  ),
  caption: [Replace this table with your data.],
) <tab:results>

@tab:results shows how to set a simple table.

= Conclusion

Say what the results mean and what remains open.

#bibliography("references.bib")
