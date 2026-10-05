#import "template.typ": report

#show: report.with(
  title: "Report title",
  subtitle: "A short description of what this report covers",
  author: "Your Name",
  date: datetime.today(),
)

#include "chapters/introduction.typ"
#include "chapters/findings.typ"
