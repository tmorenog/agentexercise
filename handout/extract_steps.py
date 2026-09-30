"""Read the build steps from the site's Scout and Meal Planner pages into steps.json.

Each step is a <section class="step"> with a title, a goal, an optional prompt
(data-prompt, a file under public/prompts), "What you should see", "Things you
can try", callouts and notes. build.py turns them into the Word handout.

Usage: python3 extract_steps.py [path to the recipes repo]  (default ../../recipes)
"""
import json
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).parent
REPO = Path(sys.argv[1]) if len(sys.argv) > 1 else (HERE / '..' / '..' / 'recipes').resolve()
VOID = {'br', 'img', 'input', 'meta', 'link', 'hr', 'source', 'wbr'}


class Node:
    def __init__(self, tag, attrs, parent=None):
        self.tag, self.attrs, self.parent, self.children = tag, dict(attrs), parent, []

    @property
    def classes(self):
        return (self.attrs.get('class') or '').split()

    def text(self):
        return ''.join(c if isinstance(c, str) else c.text() for c in self.children)

    def find_all(self, pred):
        for c in self.children:
            if isinstance(c, Node):
                if pred(c):
                    yield c
                yield from c.find_all(pred)

    def find(self, pred):
        return next(self.find_all(pred), None)


class Tree(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = self.cur = Node('root', {})

    def handle_starttag(self, tag, attrs):
        n = Node(tag, attrs, self.cur)
        self.cur.children.append(n)
        if tag not in VOID:
            self.cur = n

    def handle_endtag(self, tag):
        n = self.cur
        while n is not self.root and n.tag != tag:
            n = n.parent
        if n is not self.root:
            self.cur = n.parent

    def handle_data(self, data):
        self.cur.children.append(data)


def clean(s):
    return ' '.join(s.split())


def after_block(section, label):
    """The items under a "What you should see" / "Things you can try" label."""
    lab = section.find(lambda n: 'step-label' in n.classes and clean(n.text()) == label)
    if not lab:
        return []
    box = lab.parent
    items = [clean(li.text()) for li in box.find_all(lambda n: n.tag == 'li')]
    if items:
        return items
    return [clean(p.text()) for p in box.find_all(lambda n: n.tag == 'p' and 'step-label' not in n.classes)]


def steps_of(page):
    tree = Tree()
    tree.feed((REPO / 'public' / page).read_text())
    out = []
    for sec in tree.root.find_all(lambda n: n.tag == 'section' and 'step' in n.classes):
        title = sec.find(lambda n: 'step-title' in n.classes)
        num = title.find(lambda n: 'step-num' in n.classes)
        goal = sec.find(lambda n: 'step-goal' in n.classes)
        prompt = sec.find(lambda n: 'data-prompt' in n.attrs)
        out.append({
            'id': sec.attrs.get('id'),
            'num': clean(num.text()),
            'title': clean(title.text())[len(clean(num.text())):].strip(),
            'goal': clean(''.join(p.text() for p in goal.find_all(lambda n: n.tag == 'p' and 'step-label' not in n.classes))) if goal else '',
            'prompt': prompt.attrs['data-prompt'] if prompt else None,
            'see': after_block(sec, 'What you should see'),
            'tryit': after_block(sec, 'Things you can try'),
            'callouts': [clean(c.text()) for c in sec.find_all(lambda n: 'callout' in n.classes)],
            'notes': [clean(n.text()) for n in sec.find_all(lambda n: 'step-note' in n.classes)],
        })
    return out


if __name__ == '__main__':
    data = {'scout': steps_of('scout.html'), 'planner': steps_of('planner.html')}
    (HERE / 'steps.json').write_text(json.dumps(data, ensure_ascii=False, indent=1))
    print('steps:', {k: [s['id'] for s in v] for k, v in data.items()})
