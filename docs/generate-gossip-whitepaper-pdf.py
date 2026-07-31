#!/usr/bin/env python3
"""Generate PDF from the AirChat Gossip Layer whitepaper markdown."""

import re
import html as html_mod
from pathlib import Path
from fpdf import FPDF

DOCS_DIR = Path(__file__).resolve().parent
MD_FILE = str(DOCS_DIR / 'gossip-layer-whitepaper.md')
OUT_FILE = str(DOCS_DIR / 'gossip-layer-whitepaper.pdf')


class WhitepaperPDF(FPDF):
    def header(self):
        if self.page_no() > 1:
            self.set_font('Helvetica', 'I', 8)
            self.set_text_color(128)
            self.cell(0, 10, 'AirChat Gossip Layer Whitepaper -- Salmonrun.ai', align='C')
            self.ln(5)
            self.set_text_color(0)

    def footer(self):
        self.set_y(-15)
        self.set_font('Helvetica', 'I', 8)
        self.set_text_color(128)
        self.cell(0, 10, f'Page {self.page_no()}/{{nb}}', align='C')
        self.set_text_color(0)


def clean(text):
    text = html_mod.unescape(text)
    # Bold markers — extract text
    text = re.sub(r'\*\*(.+?)\*\*', r'\1', text)
    # Inline code
    text = re.sub(r'`(.+?)`', r'\1', text)
    # Links
    text = re.sub(r'\[(.+?)\]\(.+?\)', r'\1', text)
    # Unicode replacements for latin-1
    replacements = {
        '\u2014': '--', '\u2013': '-', '\u2018': "'", '\u2019': "'",
        '\u201c': '"', '\u201d': '"', '\u2026': '...', '\u2192': '->',
        '\u2502': '|', '\u250c': '+', '\u2510': '+', '\u2514': '+',
        '\u2518': '+', '\u251c': '+', '\u2500': '-', '\u2524': '+',
        '\u252c': '+', '\u2534': '+', '\u253c': '+', '\u2577': '|',
        '\u2575': '|', '\u2550': '=', '\u2551': '|', '\u2560': '+',
        '\u2563': '+', '\u2566': '+', '\u2569': '+', '\u256c': '+',
    }
    for old, new in replacements.items():
        text = text.replace(old, new)
    text = text.encode('latin-1', errors='replace').decode('latin-1')
    return text


def render_table(pdf, rows):
    if not rows:
        return
    parsed = []
    for row in rows:
        cells = [c.strip() for c in row.strip('|').split('|')]
        parsed.append(cells)
    if len(parsed) < 2:
        return

    header = parsed[0]
    data_rows = [
        r for r in parsed[1:]
        if not all(c.replace('-', '').replace(':', '').strip() == '' for c in r)
    ]
    if not data_rows:
        return

    num_cols = len(header)
    col_width = (pdf.w - 30) / num_cols

    pdf.set_font('Helvetica', 'B', 8)
    pdf.set_fill_color(230, 230, 230)
    for h in header:
        pdf.cell(col_width, 7, clean(h)[:50], border=1, fill=True)
    pdf.ln()

    pdf.set_font('Helvetica', '', 8)
    for row in data_rows:
        # Check page break
        if pdf.get_y() + 7 > pdf.h - 25:
            pdf.add_page()
        for i, cell in enumerate(row):
            text = clean(cell)[:80]
            pdf.cell(col_width, 7, text, border=1)
        pdf.ln()
    pdf.ln(3)


def main():
    with open(MD_FILE) as f:
        content = f.read()

    pdf = WhitepaperPDF()
    pdf.alias_nb_pages()
    pdf.set_auto_page_break(auto=True, margin=20)
    pdf.add_page()

    lines = content.split('\n')
    in_code_block = False
    code_buffer = []
    in_table = False
    table_rows = []
    is_title_page = True

    for line in lines:
        # Code block toggle
        if line.startswith('```'):
            if in_code_block:
                # Render code block
                block_height = len(code_buffer) * 5 + 4
                if pdf.get_y() + block_height > pdf.h - 25:
                    pdf.add_page()
                pdf.set_font('Courier', '', 8)
                pdf.set_fill_color(245, 245, 245)
                for cl in code_buffer:
                    if pdf.get_y() > pdf.h - 25:
                        pdf.add_page()
                    pdf.cell(0, 5, clean(cl)[:110], new_x="LMARGIN", new_y="NEXT", fill=True)
                pdf.ln(3)
                code_buffer = []
                in_code_block = False
            else:
                if in_table:
                    render_table(pdf, table_rows)
                    table_rows = []
                    in_table = False
                in_code_block = True
            continue

        if in_code_block:
            code_buffer.append(line)
            continue

        # Tables
        if '|' in line and line.strip().startswith('|'):
            if not in_table:
                in_table = True
                table_rows = []
            table_rows.append(line)
            continue
        elif in_table:
            render_table(pdf, table_rows)
            table_rows = []
            in_table = False

        # Title (# )
        if line.startswith('# ') and not line.startswith('## '):
            if is_title_page:
                pdf.ln(30)
                pdf.set_font('Helvetica', 'B', 24)
                pdf.set_text_color(20, 20, 20)
                pdf.multi_cell(0, 12, clean(line[2:]), align='C')
                pdf.ln(3)
                is_title_page = False
            else:
                pdf.set_font('Helvetica', 'B', 20)
                pdf.ln(5)
                pdf.multi_cell(0, 10, clean(line[2:]))
                pdf.ln(3)

        # Subtitle line (bold centered)
        elif line.startswith('**') and line.endswith('**') and pdf.page_no() == 1:
            pdf.set_font('Helvetica', 'B', 12)
            pdf.set_text_color(80, 80, 80)
            pdf.cell(0, 8, clean(line.strip('*')), align='C')
            pdf.ln(8)
            pdf.set_text_color(20, 20, 20)

        # Section (## )
        elif line.startswith('## ') and not line.startswith('### '):
            if pdf.get_y() > pdf.h - 50:
                pdf.add_page()
            pdf.set_font('Helvetica', 'B', 16)
            pdf.set_text_color(20, 20, 20)
            pdf.ln(5)
            pdf.set_draw_color(200)
            pdf.line(15, pdf.get_y(), pdf.w - 15, pdf.get_y())
            pdf.ln(3)
            pdf.multi_cell(0, 9, clean(line[3:]))
            pdf.ln(2)

        # Subsection (### )
        elif line.startswith('### ') and not line.startswith('#### '):
            if pdf.get_y() > pdf.h - 40:
                pdf.add_page()
            pdf.set_font('Helvetica', 'B', 13)
            pdf.set_text_color(30, 30, 30)
            pdf.ln(3)
            pdf.multi_cell(0, 8, clean(line[4:]))
            pdf.ln(2)

        # Subsubsection (#### )
        elif line.startswith('#### '):
            pdf.set_font('Helvetica', 'B', 11)
            pdf.ln(2)
            pdf.multi_cell(0, 7, clean(line[5:]))
            pdf.ln(1)

        # Horizontal rule
        elif line.strip() == '---':
            if pdf.page_no() == 1:
                pdf.ln(3)
                pdf.set_draw_color(200, 200, 200)
                pdf.line(30, pdf.get_y(), pdf.w - 30, pdf.get_y())
                pdf.ln(5)
            continue

        # Numbered list
        elif re.match(r'^\d+\.\s', line.strip()):
            pdf.set_font('Helvetica', '', 10)
            pdf.set_text_color(30, 30, 30)
            text = clean(line.strip())
            indent = 15 + (len(line) - len(line.lstrip())) * 2
            pdf.set_x(indent)
            pdf.multi_cell(0, 6, text)
            pdf.ln(1)

        # Bullet points
        elif line.strip().startswith('- ') or line.strip().startswith('* '):
            pdf.set_font('Helvetica', '', 10)
            pdf.set_text_color(30, 30, 30)
            marker = '- ' if line.strip().startswith('- ') else '* '
            text = clean(line.strip()[2:])
            indent = 15 + (len(line) - len(line.lstrip())) * 2
            pdf.set_x(indent)
            pdf.cell(5, 6, '-')
            pdf.set_x(indent + 5)
            pdf.multi_cell(0, 6, text)
            pdf.ln(0.5)

        # Empty line
        elif line.strip() == '':
            pdf.ln(2)

        # Copyright / italic line
        elif line.startswith('*') and line.endswith('*') and not line.startswith('**'):
            pdf.set_font('Helvetica', 'I', 9)
            pdf.set_text_color(100, 100, 100)
            pdf.ln(5)
            pdf.cell(0, 6, clean(line.strip('*')), align='C')
            pdf.ln(3)
            pdf.set_text_color(30, 30, 30)

        # Regular text
        else:
            pdf.set_font('Helvetica', '', 10)
            pdf.set_text_color(30, 30, 30)
            pdf.set_x(15)
            pdf.multi_cell(0, 6, clean(line.strip()))

    if in_table:
        render_table(pdf, table_rows)

    pdf.output(OUT_FILE)
    print(f'PDF generated: {OUT_FILE}')


if __name__ == '__main__':
    main()
