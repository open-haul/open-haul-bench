// Free, offline: an answer that is right but written differently is right ("6-8 am", "dock C", "245 units", "1,245"); an answer that lists several values or names another one is not.
import { sameAnswer as s } from "../core/util.mjs";
import { check, done } from "./kit.mjs";
const yes = [["6-8 am", "6-8am"], ["6–8am", "6-8am"], ["6am-8am", "6-8am"], ["6 to 8am", "6-8am"], ["12 - 2 pm", "12-2pm"], ["10am-12pm", "10am - 12pm"], ["PO 582321", "PO-582321"], ["po-582321.", "PO-582321"], ["3.70 each", "3.70"], ["$3.70", "3.70"], ["3.7", "3.70"], ["dock C", "C"], ["C.", "C"], ["the Orchard Fair", "Orchard Fair"], ["shelf 83.", "shelf 83"], ["245 units", "245"], ["1,245", "1245"], ["After 2pm", "after 2pm"], ["60 Bridge St.", "60 Bridge St"], ["before 6 am", "before 6am"], ["582321", "PO-582321"], ["PO 582321", "582321"], ["2:30 pm", "14:30"], ["11:30am", "11:30"], ["9:42", "09:42"], ["6-8am window", "6-8am"], ["12:05 pm", "12:05"]];
const no = [["6-8am", "8-10am"], ["6am-8am", "10am-12pm"], ["C or D", "C"], ["245 or 250", "245"], ["3.70 4.10", "3.70"], ["D", "C"], ["before 6am", "after 6am"], ["10-12pm", "10am-12pm"], ["nut-free", "vegan"], ["", "x"], ["12", "21"], ["shelf 83", "shelf 38"], ["2.25", "2.15"], ["dock D", "C"], ["245 units 250 units", "245"], ["2:30 am", "14:30"], ["582322", "PO-582321"], ["after 6am", "before 6am"], ["12:05 am", "12:05"]];
for (const [a, b] of yes) check(`same: ${JSON.stringify(a)} = ${JSON.stringify(b)}`, s(a, b));
for (const [a, b] of no) check(`different: ${JSON.stringify(a)} != ${JSON.stringify(b)}`, !s(a, b));
done();
