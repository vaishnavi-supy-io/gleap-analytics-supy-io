-- Run this once in the Supabase SQL editor before deploying the multi-sheet
-- Excel upload feature (Weekly Schedule / Leave Application / Commision /
-- Sheet6 / Sheet2 / Sheet3). Mirrors the existing schedule_data table style.

create table if not exists leave_requests (
  id bigint generated always as identity primary key,
  sched_key text unique not null,
  name text not null,
  day_idx int not null,
  week_offset int not null,
  leave_date date,
  role_tag text,
  source_row int,
  set_by text,
  uploaded_at timestamptz not null default now()
);

create table if not exists agent_ratings (
  id bigint generated always as identity primary key,
  rating_key text unique not null,
  name text not null,
  period_label text not null,
  source_sheet text not null,
  tickets numeric,
  rating_pct numeric,
  sla_pct numeric,
  combined_pct numeric,
  avg_val numeric,
  more_than_75 text,
  set_by text,
  uploaded_at timestamptz not null default now()
);

create table if not exists account_assignments (
  id bigint generated always as identity primary key,
  assignment_key text unique not null,
  name text not null,
  account_name text not null,
  category_tag text,
  source_sheet text not null,
  set_by text,
  uploaded_at timestamptz not null default now()
);
