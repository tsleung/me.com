import { mountTable } from "./table.js";
import { mountWithin } from "./within.js";
import { mountOverTime } from "./overtime.js";
import { mountPolicy } from "./policy.js";

mountTable(document.getElementById("table-app"));
mountWithin(document.getElementById("within-app"));
mountOverTime(document.getElementById("overtime-app"));
mountPolicy(document.getElementById("policy-app"));
